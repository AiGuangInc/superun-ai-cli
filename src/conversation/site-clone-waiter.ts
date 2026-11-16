/** 只读观察网站搬家，并沿同一任务的游标接续展示。@author xiuyu.yi */
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import type { NodePipeline } from '../contracts/node-wire.js';
import type { CreationResult, SiteCloneCursor } from '../contracts/cli-output.js';
import { CliError } from '../output/exit-codes.js';
import { executionHash } from './execution-activity.js';
import { cloneResult, cloneState } from './site-clone.js';
import type { CloneObservation } from './site-clone.js';
import { currentRound, roundContainingMessage } from './round-selector.js';
import { applySnapshot } from './session-waiter.js';

const cursorSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  endpoint: z.string(),
  accountScope: z.string(),
  taskAnchor: z.string(),
  reminderStartedAt: z.number().int().positive(),
  cloneSequence: z.number().int().nonnegative(),
  generalSequence: z.number().int().nonnegative(),
  handoff: z.object({ messageId: z.string(), observedAt: z.number().int().positive() }).optional(),
  requiredMessageId: z.string().optional(),
  submittedInteractionId: z.string().optional(),
  displayedMessages: z.array(z.object({ id: z.string(), revision: z.string() })).max(128),
});

export function parseCloneCursor(service: CreationRuntime, sessionId: string, value: unknown) {
  const parsed = cursorSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.sessionId !== sessionId ||
    parsed.data.endpoint !== service.client.config.endpoint ||
    parsed.data.accountScope !== service.client.interactionScope ||
    parsed.data.reminderStartedAt > Date.now()
  )
    throw new CliError('INVALID_ARGUMENT', '等待游标与项目、账号或环境不匹配', { sessionId });
  return parsed.data;
}

export async function waitForClone(
  service: CreationRuntime,
  sessionId: string,
  options: {
    timeout?: number;
    messageId?: string;
    submittedInteractionId?: string;
    cursor?: SiteCloneCursor;
  },
  initial?: CloneObservation,
): Promise<CreationResult> {
  service.output.stopTaskReminder();
  const deadline = options.timeout === undefined ? Infinity : Date.now() + options.timeout * 1000;
  let observation = initial;
  const { endpoint } = service.client.config;
  const projectId = encodeURIComponent(sessionId);
  const projectUrl = new URL(`/web/project/${projectId}`, endpoint).href;
  try {
    let cursor = options.cursor;
    const requiredMessageId = options.messageId ?? cursor?.requiredMessageId;
    const submittedInteractionId = options.submittedInteractionId ?? cursor?.submittedInteractionId;
    let messageObserved = !requiredMessageId;
    const displayed = new Map(cursor?.displayedMessages.map(({ id, revision }) => [id, revision]));
    let snapshot:
      { messageId: string; checkedAt: number; etag?: string; pipeline?: NodePipeline } | undefined;
    for (;;) {
      observation ??= await cloneState(service, sessionId);
      const { progress, view, head } = observation;
      const now = Date.now();
      // 创建时间是项目级稳定锚点。投影未同步的回执允许在后续完整读取时补上。
      const taskAnchor = progress.startedAt === undefined ? sessionId : `${sessionId}:${progress.startedAt}`;
      if (cursor && cursor.taskAnchor !== sessionId && progress.startedAt && cursor.taskAnchor !== taskAnchor)
        throw new CliError('INVALID_ARGUMENT', '等待游标不属于当前搬家任务');
      cursor ??= {
        version: 1,
        sessionId,
        endpoint,
        accountScope: service.client.interactionScope,
        taskAnchor,
        reminderStartedAt: progress.startedAt && progress.startedAt <= now ? progress.startedAt : now,
        cloneSequence: 0,
        generalSequence: 0,
        displayedMessages: [],
      };
      if (progress.startedAt) cursor.taskAnchor = taskAnchor;
      if (!messageObserved && requiredMessageId) {
        messageObserved =
          head.headMessageId === requiredMessageId ||
          head.headReplyMessageId === requiredMessageId ||
          !!roundContainingMessage(view, requiredMessageId);
      }
      cursor.requiredMessageId = messageObserved ? undefined : requiredMessageId;
      if (observation.idleCandidate && head.headMessageId) {
        if (cursor.handoff?.messageId !== head.headMessageId)
          cursor.handoff = { messageId: head.headMessageId, observedAt: now };
        if (now - cursor.handoff.observedAt >= 60_000) {
          progress.phase = 'NEEDS_INPUT';
          delete progress.remainingMinutes;
          delete progress.estimate;
        }
      } else cursor.handoff = undefined;
      if (
        messageObserved &&
        head.headMessageId &&
        ['READING', 'HANDOFF', 'GENERATING', 'QUEUED'].includes(progress.phase)
      ) {
        if (snapshot?.messageId !== head.headMessageId)
          snapshot = { messageId: head.headMessageId, checkedAt: 0 };
        let refreshed = false;
        if (now - snapshot.checkedAt >= 12_000) {
          snapshot.checkedAt = now;
          const update = await service.conversation
            .snapshot(sessionId, snapshot.messageId, snapshot.etag, 2_500)
            .catch(() => undefined);
          if (update?.pipeline) {
            refreshed = true;
            snapshot.pipeline = update.pipeline;
            snapshot.etag = update.etag;
          }
        }
        if (snapshot.pipeline && (refreshed || !currentRound(view)?.agentItems.length)) {
          // 已读全量决定业务阶段，增量快照补充当前消息供展示。
          observation = { ...observation, view: applySnapshot(view, snapshot.pipeline) };
        }
      }
      let result: CreationResult = messageObserved
        ? await cloneResult(service, observation)
        : { state: 'RUNNING', sessionId, siteClone: progress, messages: [], interactions: [], progress: [] };
      if (
        result.state === 'NEEDS_INPUT' &&
        submittedInteractionId &&
        result.interactions.some((item) => item.interactionId === submittedInteractionId)
      ) {
        const interactions = result.interactions.filter(
          (item) => item.interactionId !== submittedInteractionId,
        );
        result = {
          ...result,
          interactions,
          ...(interactions.length ? {} : { state: 'RUNNING' }),
          nextActions: result.nextActions?.filter((item) => item.interactionId !== submittedInteractionId),
        };
        cursor.submittedInteractionId = submittedInteractionId;
      } else cursor.submittedInteractionId = undefined;
      const resultCursor = () => ({
        ...result.cursor,
        siteClone: {
          ...cursor!,
          displayedMessages: [...displayed].slice(-128).map(([id, revision]) => ({ id, revision })),
        },
      });
      if (
        (messageObserved && (progress.phase === 'EDITING' || progress.phase === 'DEVELOPING')) ||
        !['RUNNING', 'QUEUED'].includes(result.state)
      )
        return { ...result, cursor: resultCursor() };
      service.output.cloneMessages(
        sessionId,
        result.messages.filter((message) => {
          if (message.role !== 'assistant') return false;
          const revision = executionHash(message.text);
          if (revision === displayed.get(message.id)) return false;
          displayed.delete(message.id);
          displayed.set(message.id, revision);
          return true;
        }),
      );
      const elapsed = now - cursor.reminderStartedAt;
      const cloneSequence = Math.floor(elapsed / 120_000);
      if (progress.phase !== 'NEEDS_INPUT' && cloneSequence > cursor.cloneSequence) {
        cursor.cloneSequence = cloneSequence;
        const { remainingMinutes } = progress;
        const estimate =
          remainingMinutes === undefined
            ? ''
            : remainingMinutes > 0
              ? `，预计还需 ${remainingMinutes} 分钟`
              : '，已超过预计时间';
        service.output.cloneReminder({
          id: `clone:${sessionId}:${cursor.reminderStartedAt}:${cloneSequence}`,
          sessionId,
          phase: progress.phase,
          remainingMinutes,
          projectUrl,
          url: projectUrl,
          message: `网站搬家仍在进行中${estimate}，可以打开项目查看详情。`,
        });
      }
      const generalSequence = Math.floor(elapsed / 300_000);
      if (progress.phase !== 'NEEDS_INPUT' && generalSequence > cursor.generalSequence) {
        cursor.generalSequence = generalSequence;
        service.output.reminder({
          id: `clone-general:${sessionId}:${cursor.reminderStartedAt}:${generalSequence}`,
          message: '任务还在进行中，可以去 superun.ai 查看详情。',
          url: 'https://superun.ai',
        });
      }
      if (Date.now() >= deadline) return { ...result, waitTimedOut: true, cursor: resultCursor() };
      const interval = Math.min(3000, deadline - Date.now());
      await delay(interval, undefined, { signal: service.client.signal });
      observation = undefined;
    }
  } catch (error) {
    if (service.client.signal?.aborted)
      throw new CliError('INTERRUPTED', '已停止本地等待，远端任务不受影响', { sessionId, projectUrl });
    if (error instanceof CliError)
      throw new CliError(error.code, error.message, { ...error.details, sessionId, projectUrl });
    throw error;
  }
}
