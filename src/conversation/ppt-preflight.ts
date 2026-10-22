/** PPT 专用只读前置校验，不改变通用会话选择和自动衔接。@author xiuyu.yi */
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import type { SessionView } from '../contracts/node-wire.js';
import { object } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { collectInteractions } from '../interactions/registry.js';
import { hasPendingCreationWork } from './state-resolver.js';

const chainSchema = z.array(
  z.object({
    messageId: z.string().min(1),
    sessionId: z.string(),
    role: z.number().int(),
    status: z.number().int().optional(),
  }),
);
const TEMPORARY_PREFIXES = ['fake-message-', 'pending-', 'user-', 'assistant-', 'insufficient-credits-'];

export function slidesIntent(value: unknown): boolean | null {
  return value === '1' || value === 1 ? true : value === '0' || value === 0 ? false : null;
}

export function pptHead(view: SessionView) {
  const parsed = chainSchema.safeParse(object(object(view.pipeline.lanes).chain).messages);
  if (!parsed.success) return undefined;
  const persistent = parsed.data.filter(
    (message) =>
      !TEMPORARY_PREFIXES.some((prefix) => message.messageId.startsWith(prefix)) &&
      !/^select-branch-message-.+-batch-\d+$/.test(message.messageId),
  );
  if (persistent.some((message) => message.sessionId !== view.session.sessionId)) return undefined;
  return persistent.at(-1);
}

export async function pptPreflight(service: CreationRuntime, sessionId: string, expectedSource?: string) {
  const view = await service.load(sessionId);
  if (view.session.sessionId !== sessionId)
    throw new CliError('PROTOCOL_ERROR', 'PPT 前置查询返回了不同作品');
  if (slidesIntent(view.extra.hasSlidesIntent) !== true)
    throw new CliError('INVALID_ARGUMENT', '当前作品未确认为 PPT 项目，请选择已有 PPT 或新建 PPT 作品', {
      sessionId,
    });
  const compiled =
    view.session.everDeployed === true ||
    (Number(view.extra.version) >= 2 && slidesIntent(view.extra.hasViewedDemo) === true);
  if (!compiled)
    throw new CliError('INVALID_ARGUMENT', '当前还没有满足幻灯片生成要求的编译演示，请先完成并查看演示', {
      sessionId,
    });
  if (view.session.status !== 3 || view.session.waiting !== false || view.session.errorType)
    throw new CliError(
      'INVALID_ARGUMENT',
      '当前项目仍在运行、排队、等待回答或异常状态，不能生成或确认本次 PPT',
      { sessionId, sessionStatus: view.session.status },
    );
  const head = pptHead(view);
  if (!head || head.role !== 2 || head.status !== 1)
    throw new CliError(
      'INVALID_ARGUMENT',
      '无法确认主线最后一条持久 Agent 消息已正常结束，请先查询项目进度',
      { sessionId },
    );
  if (expectedSource && head.messageId !== expectedSource)
    throw new CliError('STALE_INTERACTION', 'PPT 来源主线已变化，请重新确认本次操作目标和内容', {
      sessionId,
      sourceMessageId: expectedSource,
      currentSourceMessageId: head.messageId,
    });
  if (!view.pipeline.render || view.session.pendingBranch)
    throw new CliError('INVALID_ARGUMENT', '项目交互状态不完整或仍待选择风格，不能继续 PPT 生成', {
      sessionId,
    });
  const activeSubagentWork = await service.taskProgress.hasPendingSubagentWork(sessionId);
  const checked = { ...view, activeSubagentWork };
  if (activeSubagentWork || hasPendingCreationWork(checked))
    throw new CliError('INVALID_ARGUMENT', '当前仍有后台任务或自动工具未结束，请先等待完成', { sessionId });
  const interactions = collectInteractions(checked);
  if (interactions.length)
    throw new CliError('INVALID_ARGUMENT', '当前还有待回答的问题或选择，请先处理后再生成 PPT', {
      sessionId,
      interactions: interactions.map((binding) => binding.interaction.kind),
    });
  return { view, sourceMessageId: head.messageId };
}
