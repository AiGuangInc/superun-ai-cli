/** 智能体搭建专属入口绑定；不改变其它专家向导的默认行为。@author xiuyu.yi */
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import type { InteractionBinding } from '../interactions/context.js';
import { pendingTool } from '../interactions/context.js';
import type { SessionView } from '../contracts/node-wire.js';
import { InteractionDraftStore } from '../interactions/draft-store.js';
import { ManagedAgentResourceApi } from '../api/managed-agent-resource-api.js';
import { object, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { currentRound, roundContainingMessage } from './round-selector.js';
import { collectInteractions } from '../interactions/registry.js';
import { hasPendingCreationWork } from './state-resolver.js';
import {
  buildManagedAgentIntentRoutingArgs,
  MANAGED_AGENT_CREATION_SKILL_ID,
} from './managed-agent-entry.js';

const entrySchema = z.object({
  sessionId: z.string(),
  state: z.enum(['pending', 'active', 'complete', 'failed']),
  sourceMessageId: z.string().optional(),
  sourceReplyMessageId: z.string().optional(),
  previousMessageId: z.string().optional(),
  interactionId: z.string().optional(),
});
type Entry = z.infer<typeof entrySchema>;
const key = (sessionId: string) => `managed-agent-create-only:${sessionId}`;
const storeFor = (runtime: CreationRuntime) => new InteractionDraftStore(runtime.client.interactionScope);

async function readEntry(runtime: CreationRuntime, sessionId: string): Promise<Entry | undefined> {
  const raw = await storeFor(runtime).read(key(sessionId));
  if (raw === undefined) return undefined;
  const parsed = entrySchema.safeParse(raw);
  if (!parsed.success || parsed.data.sessionId !== sessionId)
    throw new CliError('LOCAL_STATE_RECOVERY_REQUIRED', '智能体搭建入口记录不完整，请先核对，勿重复创建');
  return parsed.data;
}

function lastMainMessage(view: SessionView) {
  const rows = object(object(view.pipeline.lanes).chain).messages;
  if (!Array.isArray(rows)) return undefined;
  const persistent = rows
    .map(object)
    .filter(
      (row) =>
        typeof row.messageId === 'string' &&
        !/^(?:fake-message-|pending-|user-|assistant-|insufficient-credits-)/.test(row.messageId) &&
        !/^select-branch-message-.+-batch-\d+$/.test(row.messageId),
    );
  if (persistent.some((row) => row.sessionId !== view.session.sessionId)) return undefined;
  return persistent.at(-1);
}

/** 对齐Agent实际工具profile；粘性的sessionExtra不能替代当前主线轮次标记。 */
function assertToolPhase(view: SessionView, head: Record<string, unknown> | undefined) {
  const rawVersion = view.extra.version;
  const version =
    typeof rawVersion === 'number'
      ? rawVersion
      : typeof rawVersion === 'string' && /^[1-9]\d*$/.test(rawVersion)
        ? Number(rawVersion)
        : NaN;
  const one = (value: unknown) => value === 1 || value === '1';
  const extra = object(head?.roundExtra);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new CliError('INVALID_ARGUMENT', '项目流程版本缺失或未知，无法确认智能体工具当前可用');
  if (!one(extra.hasSelectedStyle))
    throw new CliError('INVALID_ARGUMENT', '当前主线尚未完成风格选择，智能体配置工具不可用');
  if (version >= 4 && !one(extra.startDevelopment))
    throw new CliError(
      'INVALID_ARGUMENT',
      '当前仍在演示阶段，智能体配置工具尚未开放；请先进入研发阶段，不会自动推进',
    );
  if (version >= 6 && !one(extra.architecturePlanApproved))
    throw new CliError(
      'INVALID_ARGUMENT',
      '当前研发架构规划尚未确认，智能体配置工具不可用；请先处理当前规划',
    );
  return version;
}

/** 推荐开发功能是可选合成目录，不是等待工具回填的必答问题。 */
function blockingInteractions(view: SessionView) {
  return collectInteractions(view).filter(
    (binding) =>
      !(
        binding.interaction.kind === 'SELECT_FEATURES' &&
        binding.interaction.source.variant === 'select_features' &&
        !binding.interaction.source.toolId
      ),
  );
}

export async function agentCreationPreflight(runtime: CreationRuntime, sessionId: string) {
  const view = await runtime.load(sessionId);
  if (view.session.sessionId !== sessionId) throw new CliError('PROTOCOL_ERROR', '智能体入口返回了不同项目');
  await new ManagedAgentResourceApi(runtime.client).assertEditor(sessionId);
  const head = lastMainMessage(view);
  const version = assertToolPhase(view, head);
  const one = (value: unknown) => value === 1 || value === '1';
  if (
    !one(object(head?.roundExtra).hasSelectedStyle) ||
    (version >= 4 && !one(view.extra.hasViewedDemo)) ||
    view.session.status !== 3 ||
    view.session.waiting !== false ||
    view.session.errorType ||
    !head ||
    head.role !== 2 ||
    head.status !== 1 ||
    view.session.pendingBranch ||
    !view.pipeline.render
  )
    throw new CliError('INVALID_ARGUMENT', '请先处理当前主线任务和阶段前置，项目闲置后再搭建智能体', {
      sessionId,
    });
  const activeSubagentWork = await runtime.taskProgress.hasPendingSubagentWork(sessionId);
  const checked = { ...view, activeSubagentWork };
  if (activeSubagentWork || hasPendingCreationWork(checked) || blockingInteractions(checked).length)
    throw new CliError('INVALID_ARGUMENT', '项目仍有任务或待回答交互，请先处理当前流程', { sessionId });
  return { view, sourceMessageId: String(head.messageId) };
}

/** 入口提交前就持久化pending；ACK丢失时不把后续任意向导当成本次流程。 */
export async function startAgentCreation(
  runtime: CreationRuntime,
  sessionId: string,
  workDescription: string,
) {
  const store = storeFor(runtime);
  return store.locked(key(sessionId), async () => {
    const existing = await readEntry(runtime, sessionId);
    if (existing?.state === 'pending')
      throw new CliError('OUTCOME_UNKNOWN', '此前智能体创建入口回执未确认，请先查看项目，勿重复提交', {
        sessionId,
        retryable: false,
      });
    if (existing?.state === 'active') {
      const view = await runtime.load(sessionId);
      const entryRound = existing.sourceMessageId
        ? roundContainingMessage(view, existing.sourceMessageId)
        : undefined;
      // 入口明确正常结束且没有产生向导，例如用户改选了其它能力；只关闭该已结束入口。
      const savedWizard = existing.interactionId
        ? object(await store.read(`wizard:${sessionId}:${existing.interactionId}`))
        : {};
      const endedWizard =
        savedWizard.createOnly === true && ['complete', 'stopped'].includes(String(savedWizard.checkpoint));
      const endedWithoutWizard =
        !existing.interactionId &&
        entryRound?.status === 'completed' &&
        !blockingInteractions(view).some((binding) => binding.round.roundId === entryRound.roundId);
      if (view.session.sessionId === sessionId && (endedWithoutWizard || endedWizard)) {
        if (endedWithoutWizard) await agentCreationPreflight(runtime, sessionId);
        await store.write(key(sessionId), { ...existing, state: 'complete' });
      } else {
        if (
          view.session.sessionId !== sessionId ||
          !entryRound ||
          currentRound(view)?.roundId !== entryRound.roundId
        )
          throw new CliError(
            'STALE_INTERACTION',
            '此前智能体创建入口已被其它任务替换或无法定位，请先核对原创建结果，不能复用旧入口',
            { sessionId, sourceMessageId: existing.sourceMessageId },
          );
        return {
          sessionId,
          messageId: existing.sourceMessageId,
          entryPending: true,
          reused: true,
        };
      }
    }
    const current = await agentCreationPreflight(runtime, sessionId);
    const plugin = await runtime.plugin.operate('status', sessionId, 'SUPERUN_MANAGED_AGENT_V2');
    if (!['NOT_ENABLED', 'ENABLED'].includes(String(plugin.state)))
      throw new CliError('INVALID_ARGUMENT', '通用智能体插件尚未稳定可用，请先查询或完成当前启用流程', {
        sessionId,
        pluginState: plugin.state,
      });
    const action = plugin.state === 'ENABLED' ? 'create' : 'enable';
    const name = action === 'create' ? '新建 superun 通用智能体' : '启用 superun 通用智能体';
    const args = [
      buildManagedAgentIntentRoutingArgs(action),
      '本次是只搭建智能体配置资源的专属流程。创建后报告实际agentId并结束；不创建运行会话、不试聊、不执行工作任务、不生成管理后台、不部署或连接外部渠道。工具完成结果adminPanelRequested=false。',
      '下面是用户本次提供的智能体工作说明。最终角色设定仅使用工作说明，不包含上述流程指令：',
      workDescription,
    ].join('\n\n');
    const escape = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const record: Entry = { sessionId, state: 'pending', previousMessageId: current.sourceMessageId };
    await store.write(key(sessionId), record);
    try {
      const response = await runtime.command.chat({
        sessionId,
        content: `<command-message>${name}</command-message>\n<command-name>${MANAGED_AGENT_CREATION_SKILL_ID}</command-name>\n<command-args>${escape(args)}</command-args>\n<command-type>skill</command-type>`,
        roundExtra: { special_skill_scope: 'official' },
        businessParams: {
          skill_display: {
            skillId: MANAGED_AGENT_CREATION_SKILL_ID,
            name,
            category: 'business',
            description: '仅创建托管智能体配置资源，不运行或部署。',
          },
        },
      });
      if (response.sessionId !== undefined && response.sessionId !== sessionId)
        throw new CliError('OUTCOME_UNKNOWN', '智能体入口回执项目不一致，已保留待核对记录；请勿重发', {
          sessionId,
          retryable: false,
        });
      const sourceMessageId = text(response.messageId);
      if (!sourceMessageId)
        throw new CliError('OUTCOME_UNKNOWN', '智能体创建入口已提交但缺少源消息回执，请先核对项目，勿重发', {
          sessionId,
          retryable: false,
        });
      await store.write(key(sessionId), {
        ...record,
        state: 'active',
        sourceMessageId,
        sourceReplyMessageId: text(response.replyMessageId),
      });
      return { ...response, createOnly: true, sourceMessageId };
    } catch (error) {
      if (
        error instanceof CliError &&
        ['INVALID_ARGUMENT', 'AUTH_REQUIRED', 'BUSINESS_ERROR'].includes(error.code)
      )
        await store.write(key(sessionId), { ...record, state: 'failed' });
      throw error;
    }
  });
}

function assertScope(binding: InteractionBinding) {
  const sessionId = binding.view.session.sessionId;
  if (!sessionId || binding.round.sessionId !== sessionId || binding.item.payload.sessionId !== sessionId)
    throw new CliError(
      'UNSUPPORTED_INTERACTION',
      '当前向导不属于本次主项目资源域，首期不支持猜测父子会话映射',
      { sessionId },
    );
  return sessionId;
}

function assertCurrent(binding: InteractionBinding) {
  const latest = currentRound(binding.view);
  const head = lastMainMessage(binding.view);
  assertToolPhase(binding.view, head);
  // BFF把等待人工工具回填的PENDING轮投影为interrupted；仅接受当前未取消的真实向导。
  const waitingForWizard =
    binding.view.session.status === 4 &&
    head?.status === 4 &&
    head.messageId === binding.interaction.source.messageId &&
    binding.interaction.kind === 'MANAGED_AGENT_WIZARD' &&
    binding.item.variant === 'managed_agent_wizard' &&
    !!binding.interaction.source.toolId &&
    pendingTool(binding.item);
  if (
    !latest ||
    latest.roundId !== binding.round.roundId ||
    !head ||
    head.role !== 2 ||
    head.replyMessageId !== binding.round.anchorUserMessageId ||
    ![1, 3, 4].includes(binding.view.session.status) ||
    ![0, 1, 4].includes(Number(head.status)) ||
    typeof head.status !== 'number' ||
    binding.view.session.errorType ||
    head.sessionErrorType ||
    (!['running', 'completed'].includes(binding.round.status) &&
      !(binding.round.status === 'interrupted' && waitingForWizard)) ||
    binding.view.session.waiting !== false
  )
    throw new CliError('STALE_INTERACTION', '当前主线已离开本次智能体向导或不再允许回答，请查询当前状态');
}

/** 在首次project投影时继承入口模式，不依赖宿主记得给reply传开关。 */
export async function managedAgentCreateOnlyMode(
  runtime: CreationRuntime,
  binding: InteractionBinding,
  explicitOrSaved = false,
): Promise<boolean> {
  const sessionId = binding.view.session.sessionId;
  const entry = await readEntry(runtime, sessionId);
  if (entry?.state === 'pending')
    throw new CliError(
      'OUTCOME_UNKNOWN',
      '创建入口来源尚未确认，不能将当前向导当作旧流程绕过，请先核对原请求',
      { sessionId, retryable: false },
    );
  let bound = false;
  if (entry?.state === 'active') {
    const entryRound = entry.sourceMessageId
      ? roundContainingMessage(binding.view, entry.sourceMessageId)
      : undefined;
    bound =
      entry.interactionId === binding.interaction.interactionId ||
      binding.interaction.source.messageId === entry.sourceMessageId ||
      (entryRound !== undefined && entryRound.roundId === binding.round.roundId);
    if (!bound && !entry.interactionId)
      throw new CliError('UNSUPPORTED_INTERACTION', '当前向导无法与本次智能体入口源消息关联，不能创建资源', {
        sessionId,
      });
  }
  if (!bound && !explicitOrSaved) return false;
  assertScope(binding);
  assertCurrent(binding);
  await new ManagedAgentResourceApi(runtime.client).assertEditor(sessionId);
  if (bound && entry && !entry.interactionId) {
    await storeFor(runtime).locked(key(sessionId), async () => {
      const latest = await readEntry(runtime, sessionId);
      if (latest?.state !== 'active' || latest.sourceMessageId !== entry.sourceMessageId)
        throw new CliError('STALE_INTERACTION', '智能体搭建入口已经变化，请重新查询当前向导');
      await storeFor(runtime).write(key(sessionId), {
        ...latest,
        interactionId: binding.interaction.interactionId,
      });
    });
  }
  return true;
}

/** 资源写入和工具回填前重新读取真实绑定，不能用初次传入的旧view复核。 */
export async function verifyManagedAgentCreateOnly(runtime: CreationRuntime, binding: InteractionBinding) {
  const sessionId = assertScope(binding);
  const fresh = collectInteractions(await runtime.load(sessionId)).find(
    (candidate) => candidate.interaction.interactionId === binding.interaction.interactionId,
  );
  if (
    !fresh ||
    fresh.interaction.source.messageId !== binding.interaction.source.messageId ||
    fresh.interaction.source.toolId !== binding.interaction.source.toolId
  )
    throw new CliError('STALE_INTERACTION', '智能体向导来源已变化，未继续写入资源');
  await managedAgentCreateOnlyMode(runtime, fresh, true);
}

export async function completeAgentCreateOnly(runtime: CreationRuntime, binding: InteractionBinding) {
  const sessionId = assertScope(binding);
  const store = storeFor(runtime);
  await store.locked(key(sessionId), async () => {
    const entry = await readEntry(runtime, sessionId);
    if (entry?.state === 'active' && entry.interactionId === binding.interaction.interactionId)
      await store.write(key(sessionId), { ...entry, state: 'complete' });
  });
}
