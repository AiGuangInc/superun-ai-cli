/** 已有全托管接口的接入，定价和状态写入均由服务端负责。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { AgentQueryApi } from './agent-query-api.js';
import { object, text, enabled } from '../contracts/value.js';
import { parseWire, pipelineSchema } from '../contracts/node-wire.js';
import type { NodePipeline } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';

const amount = z.number().int().safe().nonnegative().nullish();
const statusSchema = z.object({
  autoMode: z.union([z.literal(0), z.literal(1)]),
  runId: z.string().min(1).nullish(),
  status: z.enum(['RUNNING', 'WAITING_CALLBACK', 'PAUSED', 'DONE', 'EXITED']).nullish(),
  billingMode: z.enum(['FREE_TRIAL', 'NORMAL']).nullish(),
  billingPending: z.boolean().nullish(),
  pauseReason: z.string().nullish(),
  startedAt: amount,
  completedAt: amount,
  expiresAt: amount,
  serverTime: z.number().finite(),
  tokenRate: z.number().int().safe().positive().nullish(),
  chargedTokenAmount: amount,
  consumedTokenAmount: amount,
  purchaseTokenAmount: amount,
  workSummary: z.object({ toolCallCount: amount, durationMs: amount, subTaskCount: amount }).nullish(),
});
export type AutoModeStatus = z.infer<typeof statusSchema> & {
  runId?: string | null;
  entered: boolean;
  exited: boolean;
  completionVerified: boolean;
};

export function managedEntryNotice(billingMode?: string | null) {
  return {
    estimate: '预计耗时2至6小时，预计消耗200至800算力值（按产品复杂度浮动）',
    ...(billingMode === 'FREE_TRIAL'
      ? { trial: '你是首次使用托管模式，本次托管过程不收取算力值，看到结果后满意才收费。' }
      : {}),
  };
}

export class AutoModeApi {
  private readonly query: AgentQueryApi;
  constructor(readonly client: ApiClient) {
    this.query = new AgentQueryApi(client);
  }
  private async get(path: string, sessionId: string) {
    return (
      await this.client.request(
        `/web-api/auto-mode/${path}?${new URLSearchParams({ sessionId })}`,
        undefined,
        { method: 'GET' },
      )
    ).data;
  }
  async creation(): Promise<{ agentRuntime: 'shire' | 'glow' }> {
    const account = object(
      await this.client.call('/api/uxa-center/support/UserAccount/queryAccount', { product: 13 }),
    );
    if (account.showAutoModeEntry !== true)
      throw new CliError('BUSINESS_ERROR', '当前账号尚未开放全托管，请在 superun 查看账号资格');
    const config = await this.client
      .request('/web-api/config/app-config', undefined, { method: 'GET' })
      .then((value) => object(value.data))
      .catch(() => ({}));
    return { agentRuntime: object(config).agentRuntime === 'shire' ? 'shire' : 'glow' };
  }
  async status(sessionId: string): Promise<AutoModeStatus> {
    const [raw, extra] = await Promise.all([this.get('status', sessionId), this.query.extra(sessionId)]);
    const state = parseWire(statusSchema, raw);
    const savedRun = text(extra.autoModeRunId);
    if (state.runId && savedRun && state.runId !== savedRun)
      throw new CliError('STALE_INTERACTION', '全托管运行已变化，请重新读取当前项目', { sessionId });
    const runId = state.runId ?? savedRun;
    const entered = enabled(extra.autoModeEntered),
      exited = enabled(extra.autoModeExited);
    if (state.autoMode === 1 && !runId)
      throw new CliError('PROTOCOL_ERROR', '本次托管运行标识尚未同步，请只读查询原项目，不重复创建', {
        sessionId,
      });
    if (state.autoMode === 0 && !entered && !runId)
      throw new CliError('INVALID_ARGUMENT', '当前项目不是本次全托管项目，未切换或创建其他项目', {
        sessionId,
      });
    return {
      ...state,
      runId,
      entered,
      exited,
      completionVerified:
        state.autoMode === 0 &&
        (extra.autoMode === 0 || extra.autoMode === '0') &&
        entered &&
        !exited &&
        !!runId,
    };
  }
  assertRun(state: AutoModeStatus, runId: string) {
    if (!runId || state.runId !== runId)
      throw new CliError('STALE_INTERACTION', '本次托管运行标识不匹配，未提交操作');
  }
  async quote(sessionId: string, runId: string) {
    const before = await this.status(sessionId);
    this.assertRun(before, runId);
    if (before.completionVerified) return before;
    if (before.autoMode !== 1 || before.status !== 'DONE')
      throw new CliError('INVALID_ARGUMENT', '请先等待整次全托管完成');
    const quote = parseWire(statusSchema, await this.get('credit-quote', sessionId));
    this.assertRun({ ...quote, entered: true, exited: false, completionVerified: false }, runId);
    return { ...before, ...quote };
  }
  async retry(sessionId: string, runId: string) {
    const before = await this.status(sessionId);
    this.assertRun(before, runId);
    if (before.autoMode !== 1 || before.status !== 'PAUSED')
      throw new CliError('INVALID_ARGUMENT', '只有已暂停的全托管任务可以继续', {
        sessionId,
        managed: before,
      });
    return this.client.call('/web-api/auto-mode/retry', { sessionId }, true);
  }
  async complete(
    sessionId: string,
    runId: string,
    expectedTokenAmount?: number,
    acknowledgePurchase = false,
  ) {
    const before = await this.status(sessionId);
    this.assertRun(before, runId);
    if (before.completionVerified) return { before, after: before, alreadyCompleted: true };
    if (before.autoMode !== 1 || before.status !== 'DONE')
      throw new CliError('INVALID_ARGUMENT', '请先等待整次全托管完成', { sessionId, managed: before });
    let quote;
    if (before.billingMode === 'FREE_TRIAL') {
      quote = await this.quote(sessionId, runId);
      if (quote.completionVerified) return { before, after: quote, alreadyCompleted: true };
      if (
        !Number.isSafeInteger(quote.purchaseTokenAmount) ||
        quote.purchaseTokenAmount! < 0 ||
        !quote.tokenRate
      )
        throw new CliError('PROTOCOL_ERROR', '未取得有效的实际解锁报价，未扣费');
      if (
        quote.purchaseTokenAmount !== expectedTokenAmount ||
        (!acknowledgePurchase && expectedTokenAmount !== 0)
      )
        throw new CliError(
          'STALE_INTERACTION',
          '请先向用户展示当前实际金额和项目扣费账户，取得本次付款授权；报价变化后不能沿用旧授权',
          { sessionId, runId, quote },
        );
    } else if (
      before.billingMode !== 'NORMAL' ||
      before.billingPending !== false ||
      before.chargedTokenAmount == null
    ) {
      throw new CliError('INVALID_ARGUMENT', '本次计费状态或账单仍在同步，请先查询，不重复购买', {
        sessionId,
        managed: before,
      });
    }
    let response;
    try {
      response = await this.client.call(
        `/web-api/auto-mode/${quote ? 'purchase-credits' : 'unlock-normal'}`,
        { sessionId, runId, ...(quote ? { expectedTokenAmount } : {}) },
        true,
      );
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'OUTCOME_UNKNOWN') throw error;
      const observed = await this.status(sessionId).catch(() => undefined);
      if (!observed?.completionVerified || observed.runId !== runId)
        throw new CliError('OUTCOME_UNKNOWN', '完成托管的写入结果待确认，请只查询当前状态，不重复扣费', {
          sessionId,
          runId,
          before,
          quote,
          observed,
          retryable: false,
        });
      return { before, after: observed, quote, recovered: true };
    }
    const after = await this.status(sessionId).catch(() => undefined);
    if (!after?.completionVerified || after.runId !== runId || object(response).autoMode !== 0)
      throw new CliError('OUTCOME_UNKNOWN', '完成托管已提交，但状态尚未确认；请查询后继续，不重复扣费', {
        sessionId,
        runId,
        before,
        quote,
        observed: after,
        retryable: false,
      });
    return { before, after, quote };
  }
  async history(
    sessionId: string,
    startedAt: number,
    completedAt?: number,
    untilAnchor?: string,
    entryMessageId?: string,
  ): Promise<NodePipeline> {
    const pages: NodePipeline[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    for (let count = 0; count < 200; count++) {
      const page = parseWire(
        pipelineSchema,
        await this.client.call('/web-api/conversation-v2/unified-history', {
          sessionId,
          previewVersionId: 0,
          limit: 30,
          timelineVariant: 'work_block',
          toolActivityVersion: 2,
          withAttachment: false,
          lanes: {
            chain: { ...(cursor ? { lastMessageId: cursor } : {}), hasMore: true },
            consultIndex: { hasMore: false },
          },
        }),
      );
      pages.push(page);
      const chain = object(object(page.lanes).chain),
        next = text(chain.oldestMessageId);
      const rounds = page.render?.rounds ?? [];
      if (
        chain.hasMore === false ||
        (untilAnchor && rounds.some((r) => r.anchorUserMessageId === untilAnchor)) ||
        (rounds.length > 0 &&
          rounds.every((r) => r.time.timestamp < startedAt && r.anchorUserMessageId !== entryMessageId))
      )
        break;
      if (chain.hasMore !== true || !next || seen.has(next))
        throw new CliError('PROTOCOL_ERROR', '托管历史分页未正确推进，未假报完整历程');
      if (count === 199)
        throw new CliError('PROTOCOL_ERROR', '本次历史过长，请按项目工作台继续查看，未假报完整历程');
      seen.add(next);
      cursor = next;
    }
    const rounds = new Map(pages.flatMap((p) => p.render?.rounds ?? []).map((r) => [r.roundId, r]));
    const messages = new Map(pages.flatMap((p) => p.messages).map((m) => [m.messageId, m]));
    return {
      messages: [...messages.values()].filter(
        (m) =>
          (m.createdAt >= startedAt ||
            m.messageId === entryMessageId ||
            m.replyMessageId === entryMessageId) &&
          (completedAt == null || m.createdAt <= completedAt),
      ),
      render: {
        ...pages[0]?.render,
        rounds: [...rounds.values()]
          .filter(
            (r) =>
              r.sessionId === sessionId &&
              !r.meta?.consult &&
              !r.meta?.passive &&
              (r.time.timestamp >= startedAt || r.anchorUserMessageId === entryMessageId) &&
              (completedAt == null || r.time.timestamp <= completedAt),
          )
          .sort((a, b) => a.time.timestamp - b.time.timestamp),
      },
    };
  }
}
