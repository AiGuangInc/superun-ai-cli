import assert from 'node:assert/strict';
import test from 'node:test';
import { siteUrl } from '../dist/commands/clone.js';
import { SessionWaiter } from '../dist/conversation/session-waiter.js';
import { semanticInteraction } from '../dist/interactions/parsers/semantic-action.js';
import { runCli } from '../dist/runner.js';
import { OutputWriter } from '../dist/output/writer.js';
import { CreationRuntime } from '../dist/runtime.js';
import { ApiClient } from '../dist/transport/api-client.js';

test('site URL follows the Glow clone page rules', () => {
  assert.equal(siteUrl(' example.com '), 'https://example.com');
  assert.equal(siteUrl('HTTP://Example.com/a?b=1'), 'http://Example.com/a?b=1');
  for (const value of [
    'localhost',
    'ftp://a.com',
    'https://u:p@a.com',
    'https://https://a.com',
    'a b.com',
    '',
  ])
    assert.throws(() => siteUrl(value), /网站地址/);
});

test('clone create starts a site clone project the way the Glow clone page does', async () => {
  const sessionId = 'clone-project';
  const requests = [];
  const http = {
    async request({ url, body }) {
      const path = new URL(url).pathname;
      requests.push({ path, body });
      if (path === '/web-api/detect-language') return { data: { language: 'en' } };
      if (path.endsWith('/glowChat'))
        return { data: { sessionId, messageId: 'agent', replyMessageId: 'user' } };
      if (path.endsWith('/unified-recently'))
        return {
          data: {
            session: { sessionId, topic: 'x', status: 1, workspaceId: '0' },
            pipeline: { messages: [] },
          },
        };
      return { data: {} };
    },
  };
  const client = new ApiClient({ endpoint: 'http://localhost', locale: 'zh-CN' }, 'test', http);
  let json;
  const output = new OutputWriter(
    (text) => {
      json = JSON.parse(text);
    },
    () => {},
  );
  const code = await runCli(['clone', 'create', 'example.com', '--workspace-id', 'w1'], {
    output,
    checkVersion: async () => ({}),
    patStore: { readIfPresent: async () => ({ pat: 'test-pat', source: 'env' }) },
    makeRuntime: () => new CreationRuntime(client, output),
  });
  assert.equal(code, 0);
  const chat = requests.find(({ path }) => path.endsWith('/glowChat')).body;
  assert.equal(chat.content, 'https://example.com');
  assert.equal(chat.model, undefined);
  assert.equal(chat.workspaceId, 'w1');
  assert.equal(chat.sessionId, undefined);
  assert.deepEqual(
    { ...chat.sessionExtra, source: undefined },
    {
      agentRuntime: 'shire',
      siteClone: '1',
      hasSlidesIntent: '0',
      generatedByBranch: '1',
      version: '6',
      source: undefined,
    },
  );
  assert.equal(chat.roundExtra.ROUND_LANGUAGE, 'en');
  assert.equal(json.data.state, 'ACCEPTED');
  assert.equal(json.data.sessionId, sessionId);
  assert.match(json.data.cloneNotice, /搬家/);
});

test('reading a site clone gives no manual start, other stage0 projects keep it', () => {
  const round = { roundId: 'r1', sessionId: 's', status: 'completed', agentItems: [] };
  const message = { messageId: 'm1', roundExtra: {} };
  const view = (extra) => ({ session: { sessionId: 's', status: 3 }, extra });
  assert.equal(
    semanticInteraction(view({ agentRuntime: 'shire', siteClone: '1' }), round, message),
    undefined,
  );
  assert.equal(
    semanticInteraction(view({ agentRuntime: 'shire' }), round, message).interaction.kind,
    'ENTER_IDEATION',
  );
});

function siteCloneWaiter(views, results) {
  let loads = 0;
  let inspects = 0;
  return new SessionWaiter({
    command: {},
    conversation: {},
    load: async () => views[Math.min(loads++, views.length - 1)],
    inspect: async () => results[Math.min(inspects++, results.length - 1)],
  });
}
const cloneView = (extra, pendingBranch) => ({
  session: {
    sessionId: 's',
    status: 3,
    ...(pendingBranch ? { pendingBranch: { preReplyMessageId: 'u1' } } : {}),
  },
  extra,
  pipeline: { messages: [], render: { rounds: [] }, pollingHint: { nextPollAfterMs: 1 } },
});
const ended = { state: 'COMPLETED', sessionId: 's', messages: [], progress: [], interactions: [] };

test('a site clone round that ends keeps waiting for the automatic handoff', async () => {
  const choices = { ...ended, state: 'NEEDS_SELECTION', choices: [{ choiceId: 'c0' }] };
  const waiter = siteCloneWaiter(
    [
      cloneView({ agentRuntime: 'shire', siteClone: '1' }),
      cloneView({ agentRuntime: 'shire', siteClone: '1' }),
      cloneView({ agentRuntime: 'glow', siteClone: '1' }, true),
    ],
    [ended, ended, choices],
  );
  assert.equal((await waiter.wait('s')).state, 'NEEDS_SELECTION');
});

test('ordinary projects and site clones past the first choice end without the grace', async () => {
  for (const extra of [
    { agentRuntime: 'glow' },
    { agentRuntime: 'glow', siteClone: '1', hasSelectedStyle: '1' },
  ]) {
    const waiter = siteCloneWaiter([cloneView(extra)], [ended]);
    const started = Date.now();
    assert.equal((await waiter.wait('s')).state, 'COMPLETED');
    assert.ok(Date.now() - started < 1000);
  }
});

test('a site clone that stops for the user returns once the grace runs out', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const views = [cloneView({ agentRuntime: 'shire', siteClone: '1' })];
  let calls = 0;
  const waiter = new SessionWaiter({
    command: {},
    conversation: {},
    load: async () => views[0],
    inspect: async () => {
      if (++calls === 3) t.mock.timers.tick(60_000);
      return ended;
    },
  });
  assert.equal((await waiter.wait('s')).state, 'COMPLETED');
  assert.ok(calls >= 3);
});
