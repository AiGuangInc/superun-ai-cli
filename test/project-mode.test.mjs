import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCommandApi } from '../dist/api/agent-command-api.js';
import { AutoModeApi } from '../dist/api/auto-mode-api.js';
import { AppApi } from '../dist/app/api.js';
import { ManagedAgentApi } from '../dist/api/managed-agent-api.js';
import { PublishApi } from '../dist/api/publish-api.js';
import { uploadAttachment } from '../dist/api/upload-api.js';
import { SessionWaiter } from '../dist/conversation/session-waiter.js';
import { runCli } from '../dist/runner.js';
import { OutputWriter } from '../dist/output/writer.js';
import { CreationRuntime } from '../dist/runtime.js';
import { ApiClient } from '../dist/transport/api-client.js';

const sessionId = 'test-project';
const flagPath = '/api/uxa-center/agent/AgentQuery/querySessionExtra';
function mockClient(extra, data = {}) {
  const requests = [];
  const http = {
    async request({ url, body, method, headers }) {
      const path = new URL(url).pathname;
      requests.push({ path, body, method, headers });
      if (path === flagPath) {
        assert.deepEqual(body, { sessionId });
        if (extra instanceof Error) throw extra;
        return { data: extra };
      }
      return { data: typeof data === 'function' ? data(path) : data };
    },
  };
  return { client: new ApiClient({ endpoint: 'http://localhost', locale: 'zh-CN' }, 'test', http), requests };
}

test('managed status reads both the BFF status and the POST query without a write check', async () => {
  const { client, requests } = mockClient({ autoMode: '1' }, { autoMode: 1, serverTime: 1, runId: 'r' });
  assert.equal((await new AutoModeApi(client).status(sessionId)).runId, 'r');
  assert.deepEqual(
    requests.map(({ method, path }) => [method, path]),
    [
      ['GET', '/web-api/auto-mode/status'],
      ['POST', flagPath],
    ],
  );
});

test('publish status remains a query without an extra project mode check', async () => {
  const { client, requests } = mockClient(new Error('mode lookup must not run'), { status: 'DONE' });
  assert.deepEqual(await new PublishApi(client).status(sessionId), { status: 'DONE' });
  assert.deepEqual(
    requests.map(({ path }) => path),
    ['/api/uxa-center/agent/AgentQuery/queryPublishLogInfo'],
  );
});

test('managed projects reject explicit writes in the body or header and uploads', async () => {
  const { client, requests } = mockClient({ autoMode: '1' });
  const actions = [
    () => new AgentCommandApi(client).stop(sessionId, 'all'),
    () => new AgentCommandApi(client).chat({ sessionId, content: 'edit' }),
    () => new AppApi(client).consult({ sessionId, content: 'question' }),
    () => new ManagedAgentApi(client).create(sessionId, 'agents', {}),
    () => new AgentCommandApi(client).reply(sessionId, 'tool-id'),
    () => uploadAttachment({ client }, {}, sessionId),
  ];
  for (const act of actions) {
    await assert.rejects(act, { code: 'BUSINESS_ERROR', details: { sessionId } });
  }
  assert.deepEqual(
    requests.map(({ path }) => path),
    Array(actions.length).fill(flagPath),
  );
});

test('ordinary and released projects submit their original write, new projects need no check', async () => {
  for (const extra of [{}, { autoMode: '0', autoModeRunId: 'old-run' }]) {
    const { client, requests } = mockClient(extra);
    await new AgentCommandApi(client).stop(sessionId, 'all');
    assert.deepEqual(
      requests.map(({ path }) => path),
      [flagPath, '/api/uxa-center/agent/AgentCommand/stop'],
    );
    assert.deepEqual(requests.at(-1).body, { sessionId, messageId: undefined, stopMain: 1, stopSubAgent: 1 });
  }
  const { client, requests } = mockClient({ autoMode: '1' });
  await new AgentCommandApi(client).chat({ content: 'new project', autoMode: 1 });
  assert.deepEqual(
    requests.map(({ path }) => path),
    ['/api/uxa-center/agent/AgentCommand/glowChat'],
  );
});

test('missing or invalid response and status lookup failure do not send the write', async () => {
  for (const extra of [null, { autoMode: 'unknown' }, new Error('unavailable')]) {
    const { client, requests } = mockClient(extra);
    await assert.rejects(() => new AgentCommandApi(client).stop(sessionId, 'all'));
    assert.deepEqual(
      requests.map(({ path }) => path),
      [flagPath],
    );
  }
});

test('waiting for progress keeps the existing automatic tool handling in both modes', async () => {
  for (const autoMode of ['1', '0']) {
    const replies = [];
    const waiter = new SessionWaiter({
      command: { reply: async (...args) => replies.push(args) },
      load: async () => ({
        session: { sessionId, status: 3 },
        extra: { autoMode },
        pipeline: {
          messages: [
            {
              messageId: 'm',
              displayContents: [{ tool: { toolStatus: 0, toolData: { toolName: 'ReadLogs', toolId: 't' } } }],
            },
          ],
        },
      }),
      inspect: async () => ({ state: 'COMPLETED', messages: [], progress: [] }),
    });
    assert.equal((await waiter.wait(sessionId)).state, 'COMPLETED');
    assert.deepEqual(replies, [[sessionId, 't']]);
  }
});

test('CLI reads a managed project quote but does not submit purchase, unlock or retry', async () => {
  for (const billingMode of ['FREE_TRIAL', 'NORMAL']) {
    const state = {
      autoMode: 1,
      runId: 'r',
      status: 'DONE',
      serverTime: 1,
      billingMode,
      purchaseTokenAmount: 100,
      tokenRate: 100,
      billingPending: false,
      chargedTokenAmount: 100,
    };
    const { client, requests } = mockClient({ autoMode: '1', autoModeRunId: 'r' }, (path) => {
      if (['/web-api/auto-mode/status', '/web-api/auto-mode/credit-quote'].includes(path)) return state;
      if (path.endsWith('/unified-recently'))
        return {
          session: { sessionId, topic: 'test', status: 3, workspaceId: '0' },
          pipeline: { messages: [] },
        };
      assert.fail(`Unexpected request: ${path}`);
    });
    async function execute(action, args = []) {
      let json;
      const output = new OutputWriter(
        (text) => {
          json = JSON.parse(text);
        },
        () => {},
      );
      const code = await runCli(['chat', 'auto-mode', action, sessionId, '--run-id', 'r', ...args], {
        output,
        checkVersion: async () => ({}),
        patStore: { readIfPresent: async () => ({ pat: 'test-pat', source: 'env' }) },
        makeRuntime: () => new CreationRuntime(client, output),
      });
      return { code, json };
    }
    const quote = await execute('quote');
    assert.equal(quote.code, 0);
    assert.equal(quote.json.data.nextActions[0].url, `http://localhost/web/project/${sessionId}`);
    const completion = await execute('complete', [
      '--acknowledge-purchase',
      '--expected-token-amount',
      '100',
    ]);
    state.status = 'PAUSED';
    const retry = await execute('retry');
    for (const result of [completion, retry]) {
      assert.equal(result.json.error.code, 'BUSINESS_ERROR');
      assert.match(result.json.error.message, /CLI 仅支持查询/);
      assert.equal(result.code, 5);
    }
    assert.ok(requests.every(({ path }) => !/\/(purchase-credits|unlock-normal|retry)$/.test(path)));
  }
});
