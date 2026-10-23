/** 检查类写操作的主线、阶段与服务端编辑权限门禁。@author xiuyu.yi */
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import { parseWire, type SessionView } from '../contracts/node-wire.js';
import { object } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { currentRound, roundContainingMessage } from './round-selector.js';
import { collectInteractions } from '../interactions/registry.js';
import { hasPendingCreationWork } from './state-resolver.js';

const chainSchema = z.array(
  z.object({
    messageId: z.string().min(1),
    sessionId: z.string(),
    role: z.number().int(),
    status: z.number().int(),
    replyMessageId: z.string().optional(),
    roundExtra: z.record(z.unknown()).optional(),
    extra: z.record(z.unknown()).optional(),
  }),
);
const one = (value: unknown) => value === '1' || value === 1;

export async function projectCheckPreflight(
  service: CreationRuntime,
  view: SessionView,
  sessionId: string,
  label: string,
) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || view.session.sessionId !== sessionId)
    throw new CliError('PROTOCOL_ERROR', '检查目标与本次单个作品不一致');
  // 复用有服务端编辑权限检查的只读方法；不以菜单可见或分享可访问代替权限。
  const editing = parseWire(
    z.object({ hasStaging: z.boolean(), files: z.array(z.unknown()) }),
    await service.client.call('/api/uxa-center/agent/AgentQuery/queryAgentAttachmentGit', {
      sessionId,
      withContent: false,
    }),
  );
  if (editing.hasStaging !== editing.files.length > 0)
    throw new CliError('PROTOCOL_ERROR', '源码暂存状态不完整，未继续操作');
  const chain = chainSchema.safeParse(object(object(view.pipeline.lanes).chain).messages);
  if (!chain.success || chain.data.some((row) => row.sessionId !== sessionId))
    throw new CliError('PROTOCOL_ERROR', '无法核对当前物理主线，未发起检查');
  const head = chain.data
    .filter(
      (row) =>
        !/^(?:fake-message-|pending-|user-|assistant-|insufficient-credits-)/.test(row.messageId) &&
        !/^select-branch-message-.+-batch-\d+$/.test(row.messageId),
    )
    .at(-1);
  const round = head ? roundContainingMessage(view, head.messageId) : undefined;
  if (
    !head ||
    head.role !== 2 ||
    head.status !== 1 ||
    !round ||
    round.sessionId !== sessionId ||
    currentRound(view)?.roundId !== round.roundId ||
    round.status !== 'completed' ||
    view.session.status !== 3 ||
    view.session.waiting !== false ||
    view.session.errorType ||
    view.session.pendingBranch ||
    view.extra.agentRuntime === 'shire'
  )
    throw new CliError(
      'INVALID_ARGUMENT',
      `当前主线不是已正常结束的常规创作流程，请先处理当前任务，再执行${label}`,
      { sessionId },
    );
  const rawVersion = view.extra.version;
  const version =
    typeof rawVersion === 'number'
      ? rawVersion
      : typeof rawVersion === 'string' && /^[1-9]\d*$/.test(rawVersion)
        ? Number(rawVersion)
        : NaN;
  const extra = object(head.roundExtra);
  if (!Number.isSafeInteger(version) || version < 1 || !one(extra.hasSelectedStyle))
    throw new CliError('INVALID_ARGUMENT', `尚未完成风格选择或流程版本未知，${label}工具当前不可用`, {
      sessionId,
    });
  const stage = version < 4 || one(extra.startDevelopment) ? 'development' : 'demo';
  if (version >= 6 && stage === 'development' && !one(extra.architecturePlanApproved))
    throw new CliError('INVALID_ARGUMENT', `当前研发规划尚未确认，不能执行${label}；不会自动确认规划`, {
      sessionId,
    });
  const activeSubagentWork = await service.taskProgress.hasPendingSubagentWork(sessionId);
  const checked = { ...view, activeSubagentWork };
  const blocking = collectInteractions(checked).filter(
    ({ interaction }) =>
      !(
        interaction.kind === 'SELECT_FEATURES' &&
        interaction.source.variant === 'select_features' &&
        !interaction.source.toolId
      ),
  );
  if (activeSubagentWork || hasPendingCreationWork(checked) || blocking.length)
    throw new CliError('INVALID_ARGUMENT', `当前仍有后台任务或必答问题，请先处理后再执行${label}`, {
      sessionId,
    });
  return { sourceMessageId: head.messageId, stage, hasStaging: editing.hasStaging };
}
