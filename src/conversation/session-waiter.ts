/** 增量快照轮询，并定期刷新会话级事实。@author xiuyu.yi */
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionView, NodePipeline } from '../contracts/node-wire.js';
import type { CreationResult } from '../contracts/cli-output.js';
import type { ConversationApi } from '../api/conversation-api.js';
import type { AgentCommandApi } from '../api/agent-command-api.js';
import { currentRound, roundMessage } from './round-selector.js';
import { pendingAutomaticTools } from '../auto-tools/registry.js';
import { replyReadLogs } from '../auto-tools/read-logs.js';
import { CliError } from '../output/exit-codes.js';
import type { StyleWaitTarget } from '../interactions/parsers/style-selection.js';

export type WaitOptions = {
  timeout?: number;
  interval?: number;
  messageId?: string;
  submittedInteractionId?: string;
  styleTarget?: StyleWaitTarget;
};

export function applySnapshot(view: SessionView, pipeline: NodePipeline): SessionView {
  const messages = new Map(view.pipeline.messages.map((message) => [message.messageId, message]));
  for (const message of pipeline.messages) messages.set(message.messageId, message);
  let rounds = [...(view.pipeline.render?.rounds ?? [])];
  if (pipeline.render)
    for (const round of pipeline.render.rounds) {
      rounds = [...rounds.filter((item) => item.roundId !== round.roundId), round];
    }
  const update = pipeline.roundPatch;
  if (update) {
    const { patch } = update;
    const previous = rounds.find((round) => round.roundId === update.roundId);
    if (patch.operation === 'upsert-round' && patch.round)
      rounds = [...rounds.filter((round) => round.roundId !== update.roundId), patch.round];
    else if (previous) {
      const merged = {
        ...previous,
        ...(patch.agentItems ? { agentItems: patch.agentItems } : {}),
        ...(patch.userItems ? { userItems: patch.userItems } : {}),
        status: patch.status ?? previous.status,
        meta: patch.meta ?? previous.meta,
        activity: patch.activity ?? previous.activity,
        time: patch.time ?? previous.time,
      };
      rounds = rounds.map((round) => (round.roundId === update.roundId ? merged : round));
    }
  }
  const last = [...pipeline.messages].sort((a, b) => a.createdAt - b.createdAt).at(-1);
  return {
    ...view,
    session: {
      ...view.session,
      status: last?.sessionStatus ?? view.session.status,
      errorType: last?.sessionErrorType ?? view.session.errorType,
    },
    pipeline: {
      ...view.pipeline,
      ...pipeline,
      pollingHint: pipeline.pollingHint,
      roundPatch: pipeline.roundPatch,
      messages: [...messages.values()],
      render: { ...view.pipeline.render, rounds },
    },
  };
}

export class SessionWaiter {
  constructor(
    private readonly dependencies: {
      conversation: ConversationApi;
      command: AgentCommandApi;
      load: (sessionId: string) => Promise<SessionView>;
      inspect: (view: SessionView, styleTarget?: StyleWaitTarget) => Promise<CreationResult>;
      signal?: AbortSignal;
    },
  ) {}

  async wait(sessionId: string, options: WaitOptions = {}): Promise<CreationResult> {
    const deadline =
      options.timeout === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.timeout * 1000;
    let view = await this.dependencies.load(sessionId),
      lastRefresh = Date.now();
    let etag: string | undefined,
      target: string | undefined = options.messageId,
      unchanged = 0;
    const replied = new Set<string>(),
      messages = new Map<string, CreationResult['messages'][number]>();
    const progress = new Map<string, CreationResult['progress'][number]>();
    while (true) {
      if (this.dependencies.signal?.aborted)
        throw new CliError('INTERRUPTED', '已停止本地等待，远端任务继续运行', {
          sessionId,
          messageId: target,
        });
      for (const tool of pendingAutomaticTools(view)) {
        if (!replied.has(tool.key) && pendingAutomaticTools(view).some((active) => active.key === tool.key)) {
          await replyReadLogs(this.dependencies.command, sessionId, tool.toolId);
          replied.add(tool.key);
          view = await this.dependencies.load(sessionId);
        }
      }
      let result = await this.dependencies.inspect(view, options.styleTarget);
      const suppressSubmitted = (value: CreationResult): CreationResult => {
        if (!options.submittedInteractionId || value.state !== 'NEEDS_INPUT') return value;
        const interactions = value.interactions.filter(
          (item) => item.interactionId !== options.submittedInteractionId,
        );
        return { ...value, interactions, state: interactions.length ? 'NEEDS_INPUT' : 'RUNNING' };
      };
      result = suppressSubmitted(result);
      if (!['RUNNING', 'QUEUED'].includes(result.state)) {
        // 终态和交互退出前重读全量，防止快照漏掉新轮或服务端刚完成的交接。
        view = await this.dependencies.load(sessionId);
        result = suppressSubmitted(await this.dependencies.inspect(view, options.styleTarget));
      }
      for (const item of result.messages) messages.set(item.id, item);
      for (const item of result.progress) progress.set(item.id, item);
      if (!['RUNNING', 'QUEUED'].includes(result.state))
        return {
          ...result,
          messages: [...messages.values()],
          progress: [...progress.values()],
          cursor: { ...result.cursor, etag },
        };
      if (Date.now() >= deadline)
        return {
          ...result,
          messages: [...messages.values()],
          progress: [...progress.values()],
          waitTimedOut: true,
          cursor: { ...result.cursor, etag },
        };
      const hint = view.pipeline.pollingHint;
      const interval = Math.max(
        (options.interval ?? 0) * 1000,
        hint?.nextPollAfterMs ?? (unchanged ? 5000 : 2000),
      );
      try {
        await delay(Math.min(Math.max(interval, 100), deadline - Date.now()), undefined, {
          signal: this.dependencies.signal,
        });
      } catch {
        throw new CliError('INTERRUPTED', '已停止本地等待，远端任务继续运行', {
          sessionId,
          messageId: target,
        });
      }
      const latestMessage = roundMessage(view, currentRound(view))?.messageId;
      if (latestMessage && latestMessage !== target) {
        target = latestMessage;
        etag = undefined;
      }
      if (
        !target ||
        options.styleTarget ||
        view.session.pendingBranch ||
        Date.now() - lastRefresh >= 10_000
      ) {
        view = await this.dependencies.load(sessionId);
        lastRefresh = Date.now();
        etag = undefined;
      } else {
        const snapshot = await this.dependencies.conversation.snapshot(
          sessionId,
          target,
          hint?.bypassIfNoneMatch ? undefined : etag,
        );
        etag = snapshot.etag;
        if (snapshot.pipeline) {
          view = applySnapshot(view, snapshot.pipeline);
          unchanged = 0;
        } else unchanged++;
      }
    }
  }
}
