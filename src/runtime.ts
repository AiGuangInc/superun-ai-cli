/** 组织项目创作、交互回复和任务查询。@author xiuyu.yi */
import { AgentCommandApi } from './api/agent-command-api.js';
import { AgentQueryApi } from './api/agent-query-api.js';
import { ConfigApi } from './api/config-api.js';
import { ConversationApi } from './api/conversation-api.js';
import { IntegrationApi } from './api/integration-api.js';
import { PluginApi } from './api/plugin-api.js';
import { PublishApi } from './api/publish-api.js';
import { PreviewVersionApi } from './api/preview-version-api.js';
import type { ApiClient } from './transport/api-client.js';
import type { OutputWriter } from './output/writer.js';
import type { SessionView } from './contracts/node-wire.js';
import type { CreationResult, Choice } from './contracts/cli-output.js';
import { enabled, object, text } from './contracts/value.js';
import type { JsonObject } from './contracts/value.js';
import { collectInteractions } from './interactions/registry.js';
import { toolId as sourceToolId, toolData } from './interactions/context.js';
import { integrationKey } from './interactions/handlers/reply-plugin.js';
import {
  isStyleSelected,
  projectChoices,
  styleBranchAnchor,
  styleWaitTarget,
} from './interactions/parsers/style-selection.js';
import type { StyleWaitTarget } from './interactions/parsers/style-selection.js';
import { resolveState } from './conversation/state-resolver.js';
import { buildNextActions } from './conversation/next-actions.js';
import {
  findModifiedDemoPreview,
  isInitialDemoRound,
  projectDemoPreview,
} from './conversation/demo-preview.js';
import { findDevelopmentSnapshot } from './conversation/development-snapshot.js';
import type { GuidanceResult } from './conversation/next-actions.js';
import { currentRound, roundMessage } from './conversation/round-selector.js';
import { SessionWaiter } from './conversation/session-waiter.js';
import type { WaitOptions } from './conversation/session-waiter.js';
import { CliError } from './output/exit-codes.js';
import { dispatchReply } from './interactions/handlers/index.js';

// 只限制完成结果的短暂同步，不限制用户回答或研发任务的总等待时间。
const DEVELOPMENT_SNAPSHOT_SYNC_MS = 15_000;

export class CreationRuntime {
  readonly command: AgentCommandApi;
  readonly query: AgentQueryApi;
  readonly config: ConfigApi;
  readonly conversation: ConversationApi;
  readonly integration: IntegrationApi;
  readonly plugin: PluginApi;
  readonly publish: PublishApi;
  readonly previewVersions: PreviewVersionApi;
  readonly waiter: SessionWaiter;
  private snapshotSync?: { key: string; startedAt: number };
  constructor(
    readonly client: ApiClient,
    readonly output: OutputWriter,
  ) {
    this.command = new AgentCommandApi(client);
    this.query = new AgentQueryApi(client);
    this.config = new ConfigApi(client);
    this.conversation = new ConversationApi(client);
    this.integration = new IntegrationApi(client);
    this.plugin = new PluginApi(client);
    this.publish = new PublishApi(client);
    this.previewVersions = new PreviewVersionApi(client);
    this.waiter = new SessionWaiter({
      conversation: this.conversation,
      command: this.command,
      load: (id) => this.load(id),
      inspect: (view, styleTarget) => this.inspect(view, styleTarget),
      signal: client.signal,
    });
  }
  async load(sessionId: string): Promise<SessionView> {
    const [recently, extra] = await Promise.all([
      this.conversation.recently(sessionId),
      this.query.extra(sessionId),
    ]);
    const view: SessionView = { ...recently, extra };
    const round = currentRound(view),
      message = roundMessage(view, round);
    if (
      view.session.status === 3 &&
      extra.agentRuntime !== 'shire' &&
      message?.roundExtra?.hasSelectedStyle === '1' &&
      !enabled(object(message.extra).featureListConfirmed)
    ) {
      view.features = await this.query.features(sessionId, round?.anchorUserMessageId);
    }
    return view;
  }
  async choices(sessionId: string, anchor?: string, view?: SessionView): Promise<Array<Choice>> {
    const accessible = view ?? (await this.load(sessionId));
    const preReplyMessageId = anchor ?? styleBranchAnchor(accessible);
    if (!preReplyMessageId) return [];
    return projectChoices(await this.query.parallel(sessionId, preReplyMessageId), preReplyMessageId);
  }
  async inspect(view: SessionView, styleTarget?: StyleWaitTarget): Promise<CreationResult> {
    const anchor = styleTarget?.preReplyMessageId ?? styleBranchAnchor(view);
    const choices = anchor ? await this.choices(view.session.sessionId, anchor, view) : [];
    const bindings = collectInteractions(view, !styleTarget && isStyleSelected(view, choices));
    const processingIds = new Set<string>();
    for (const binding of bindings) {
      if (binding.interaction.kind !== 'PLUGIN_ACTION') continue;
      const pluginName = text(toolData(binding.item).pluginName);
      if (!pluginName) continue;
      const state = await this.integration.status(view.session.sessionId, integrationKey(pluginName));
      if (['ENABLING', 'RESTORING', 'PAUSING', 'DISABLING'].includes(String(state.integrationStatus)))
        processingIds.add(binding.interaction.interactionId);
    }
    const result = resolveState(
      { ...view, automaticWork: processingIds.size > 0 },
      bindings.filter((binding) => !processingIds.has(binding.interaction.interactionId)),
      choices,
      styleTarget,
    );
    if (result.state === 'COMPLETED' && isStyleSelected(view, choices) && isInitialDemoRound(view)) {
      const message = roundMessage(view, currentRound(view));
      if (
        Number(view.extra.demoGenerateStatus) !== 2 ||
        Number(message?.roundExtra?.demoReadyAt) > Date.now()
      )
        return { ...result, state: 'RUNNING' };
      const demo = projectDemoPreview(await this.query.snapshots(view.session.sessionId), view, choices);
      // 不能用“消息完成”代替演示就绪，也不能拿另一种风格的最新快照兜底。
      if (!demo) return { ...result, state: 'RUNNING' };
      result.demo = demo;
    }
    const roundExtra = roundMessage(view, currentRound(view))?.roundExtra ?? {};
    const started = enabled(roundExtra.startDevelopment);
    const planApproved = enabled(roundExtra.architecturePlanApproved);
    const modifiedDemo =
      result.state === 'COMPLETED' &&
      !started &&
      !isInitialDemoRound(view) &&
      enabled(view.extra.hasViewedDemo) &&
      enabled(roundExtra.showConfirmGenerateMoreDemo);
    if (modifiedDemo) {
      result.demo = await findModifiedDemoPreview(this.query, view);
      if (result.demo) this.snapshotSync = undefined;
      else {
        const key = `demo:${view.session.sessionId}:${currentRound(view)?.roundId}`;
        if (this.snapshotSync?.key !== key) this.snapshotSync = { key, startedAt: Date.now() };
        if (Date.now() - this.snapshotSync.startedAt < DEVELOPMENT_SNAPSHOT_SYNC_MS)
          return { ...result, state: 'RUNNING' };
      }
    }
    if (started || result.demo?.viewed || modifiedDemo) {
      result.development = {
        started,
        planApproved,
        stage: !started
          ? 'READY'
          : result.interactions.some((item) => item.kind === 'APPROVE_ARCHITECTURE_PLAN')
            ? 'PLAN_REVIEW'
            : result.interactions.some((item) => item.kind === 'SELECT_FEATURES')
              ? 'FEATURE_SELECTION'
              : result.interactions.some((item) => item.kind === 'START_EXECUTION')
                ? 'EXECUTION_REVIEW'
                : !planApproved
                  ? 'PLANNING'
                  : result.state === 'COMPLETED'
                    ? 'COMPLETED'
                    : 'DEVELOPING',
      };
      if (result.development.stage === 'PLAN_REVIEW')
        result.attachments = (await this.query.attachments(view.session.sessionId, ['README.md'])).filter(
          (attachment) => attachment.name === 'README.md',
        );
      const current = currentRound(view);
      const onlyFeatureSelection = result.interactions.every((item) => item.kind === 'SELECT_FEATURES');
      if (
        started &&
        planApproved &&
        current &&
        onlyFeatureSelection &&
        ['COMPLETED', 'NEEDS_INPUT'].includes(result.state) &&
        !['start_dev', 'architecture_plan_approve'].includes(String(roundExtra.business_type))
      ) {
        const messageId = current.anchorUserMessageId;
        const snapshot = await findDevelopmentSnapshot(this.query, view.session.sessionId, messageId);
        if (snapshot) {
          result.development.snapshot = snapshot;
          this.snapshotSync = undefined;
        } else {
          const key = `${view.session.sessionId}:${messageId}`;
          if (this.snapshotSync?.key !== key) this.snapshotSync = { key, startedAt: Date.now() };
          const pending = Date.now() - this.snapshotSync.startedAt < DEVELOPMENT_SNAPSHOT_SYNC_MS;
          result.development.snapshot = {
            status: pending ? 'PENDING' : 'UNAVAILABLE',
            messageId,
            reason: pending
              ? '正在同步本轮研发快照，请稍候。'
              : '本轮暂未查到匹配的研发快照，可稍后查询；不能使用旧演示链接代替。',
          };
          if (pending) {
            result.state = 'RUNNING';
            result.interactions = [];
          }
        }
      }
    }
    return result;
  }
  async state(sessionId: string): Promise<CreationResult> {
    return this.withGuidance(await this.inspect(await this.load(sessionId)));
  }
  withGuidance<T extends GuidanceResult>(result: T) {
    return { ...result, nextActions: buildNextActions(result, this.client.config) };
  }
  async wait(sessionId: string, options: WaitOptions): Promise<CreationResult> {
    // 等待器可能过滤已提交的交互，必须在最终结果确定后生成引导。
    return this.withGuidance(await this.waiter.wait(sessionId, options));
  }
  async accepted(
    response: JsonObject,
    sessionId: string | undefined,
    wait: boolean,
    options: WaitOptions,
  ): Promise<CreationResult> {
    const id = text(response.sessionId) ?? sessionId;
    if (!id)
      throw new CliError('OUTCOME_UNKNOWN', '写请求已返回，但响应中缺少 sessionId，请查询会话列表确认');
    if (wait)
      return this.wait(id, {
        ...options,
        messageId: text(response.messageId) ?? options.messageId,
        requiredMessageId: text(response.messageId) ?? text(response.replyMessageId),
        styleTarget: styleWaitTarget(response) ?? options.styleTarget,
      });
    return this.withGuidance({
      state: 'ACCEPTED',
      sessionId: id,
      messageId: text(response.messageId),
      replyMessageId: text(response.replyMessageId),
      messages: [],
      progress: [],
      interactions: [],
      cursor: { branchAnchor: text(response.preReplyMessageId) },
    });
  }
  async generateStyles(
    sessionId: string,
    content: string,
    count: number,
    preReplyMessageId?: string,
  ): Promise<JsonObject> {
    const view = await this.load(sessionId);
    if (view.extra.agentRuntime === 'shire')
      throw new CliError('INVALID_ARGUMENT', '当前处于 Stage0，请先完成进入构想阶段的交接');
    const response = await this.command.parallel({
      sessionId,
      preReplyMessageId,
      items: Array.from({ length: count }, (_, index) => ({
        index,
        mode: 6,
        framework: 6,
        content,
        businessParams: { business_type: 'startMV' },
      })),
    });
    await this.command.sessionExtra(sessionId, {
      hasClarifiedPrd: '1',
      generatedByBranch: '1',
      version: '6',
    });
    return response;
  }
  async selectStyle(sessionId: string, choiceId: string): Promise<JsonObject> {
    const choice = (await this.choices(sessionId)).find((item) => item.choiceId === choiceId);
    if (!choice)
      throw new CliError('STALE_INTERACTION', '当前未决批次中不存在该风格，请重新执行 chat style list');
    if (choice.status !== 'success' || choice.errorType)
      throw new CliError('INVALID_ARGUMENT', '只能选择成功生成的风格');
    if (choice.selected)
      throw new CliError('STALE_INTERACTION', '该风格已经选中，请查看演示，勿重复提交选择', { sessionId });
    const now = Date.now();
    const stageExtra = {
      hasSelectedStyle: '1',
      hasGeneratedIdea: String(now + 3000),
      demoReadyAt: String(now + 6000),
    };
    const response = await this.command.chat({
      sessionId,
      minDuration: 10,
      content: `选择风格 ${choice.index + 1}`,
      parallelSelectRequest: {
        sessionId,
        selectedReplyMessageId: choice.replyMessageId,
        selectedLastReplyMessageId: choice.lastReplyMessageId ?? choice.replyMessageId,
      },
      roundExtra: { ...stageExtra, business_type: 'choose_style_v2' },
      businessParams: { business_type: 'choose_style_v2' },
    });
    try {
      await this.command.sessionExtra(sessionId, stageExtra);
    } catch {
      throw new CliError('OUTCOME_UNKNOWN', '风格选择已提交，但阶段状态同步未确认；请查询会话，勿重复选择', {
        sessionId,
        messageId: text(response.messageId),
        replyMessageId: text(response.replyMessageId),
        phase: 'STYLE_SELECTION_SYNC',
        retryable: false,
      });
    }
    return response;
  }
  async viewDemo(sessionId: string): Promise<CreationResult> {
    const view = await this.load(sessionId);
    const round = currentRound(view);
    const extra = roundMessage(view, round)?.roundExtra ?? {};
    const result = await this.inspect(view);
    // 已有查看轮时只等待其结果，不重复发送查看消息。
    if (
      round &&
      extra.business_type === 'fake_confirm_generate_more_demo' &&
      !enabled(extra.startDevelopment)
    ) {
      if (!enabled(view.extra.hasViewedDemo))
        await this.command.sessionExtra(sessionId, { hasViewedDemo: '1' });
      return this.waitForDemoView(sessionId, round.anchorUserMessageId);
    }
    if (result.state !== 'COMPLETED' || !result.demo)
      throw new CliError('INVALID_ARGUMENT', '当前演示尚不可查看，请先查询并等待当前任务完成', { sessionId });
    // 查看与选择是两个动作；只在取得对应演示快照后记录已查看。
    if (!enabled(view.extra.hasViewedDemo))
      await this.command.sessionExtra(sessionId, { hasViewedDemo: '1' });
    if (
      Number(view.extra.version) >= 4 &&
      !enabled(extra.showConfirmGenerateMoreDemo) &&
      !enabled(extra.generateDemo) &&
      !enabled(extra.startDevelopment)
    ) {
      const response = await this.command.viewDemo(sessionId);
      const messageId = text(response.messageId) ?? text(response.replyMessageId);
      if (!messageId)
        throw new CliError(
          'OUTCOME_UNKNOWN',
          '查看演示已提交，但响应缺少消息标识；请查询当前状态，勿重复提交',
          {
            sessionId,
            phase: 'DEMO_VIEW',
            retryable: false,
          },
        );
      return this.waitForDemoView(sessionId, messageId);
    }
    return this.withGuidance({
      ...result,
      demo: { ...result.demo, viewed: true },
      development: { stage: 'READY', started: false, planApproved: false },
    });
  }
  private async waitForDemoView(sessionId: string, messageId: string): Promise<CreationResult> {
    // 只约束查看演示这一条等待链，普通创作的等待行为保持不变。
    const waiter = new SessionWaiter({
      conversation: this.conversation,
      command: this.command,
      load: (id) => this.load(id),
      signal: this.client.signal,
      inspect: async (view) => {
        const latest = currentRound(view);
        if (view.session.status === -1 || view.session.errorType || latest?.status === 'failed')
          return this.inspect(view);
        const targetRound = view.pipeline.render?.rounds.find(
          (round) =>
            round.anchorUserMessageId === messageId ||
            [...round.userItems, ...round.agentItems].some(
              (item) => (item.source?.messageId ?? text(item.payload.messageId)) === messageId,
            ),
        );
        if (targetRound && latest?.roundId !== targetRound.roundId)
          throw new CliError('STALE_INTERACTION', '查看演示后会话已进入其他轮次，请查询当前状态', {
            sessionId,
            messageId,
          });
        if (!targetRound || !enabled(view.extra.hasViewedDemo))
          return {
            state: 'RUNNING',
            sessionId,
            messageId,
            messages: [],
            progress: [],
            interactions: [],
          };
        return this.inspect(view);
      },
    });
    return this.withGuidance(await waiter.wait(sessionId, { messageId }));
  }
  async startDevelopment(sessionId: string): Promise<JsonObject> {
    const view = await this.load(sessionId);
    const extra = roundMessage(view, currentRound(view))?.roundExtra ?? {};
    if (enabled(extra.startDevelopment))
      throw new CliError('STALE_INTERACTION', '项目已进入研发，请继续处理当前规划或任务，勿重复进入', {
        sessionId,
      });
    const result = await this.inspect(view);
    if (result.state !== 'COMPLETED' || !result.demo?.viewed)
      throw new CliError('INVALID_ARGUMENT', '请先完成并查看演示，再进入研发', { sessionId });
    await this.previewVersions.prepareDevelopment(sessionId);
    const response = await this.command.chat({
      sessionId,
      previewVersionId: 0,
      content: '开始研发，先生成研发规划',
      businessParams: { business_type: 'start_dev' },
      roundExtra: { startDevelopment: '1', showDismissInBuildTutorial: '0' },
    });
    try {
      await this.command.sessionExtra(sessionId, { startDevelopment: '1', hasViewedBuild: '1' });
    } catch {
      throw new CliError('OUTCOME_UNKNOWN', '进入研发已提交，但阶段同步未确认；请查询当前任务，勿重复进入', {
        sessionId,
        messageId: text(response.messageId),
        phase: 'DEVELOPMENT_SYNC',
        retryable: false,
      });
    }
    return response;
  }
  async reply(sessionId: string, interactionId: string, input: JsonObject): Promise<JsonObject> {
    const view = await this.load(sessionId);
    const binding = collectInteractions(view).find(
      (item) => item.interaction.interactionId === interactionId,
    );
    if (!binding)
      throw new CliError('STALE_INTERACTION', '交互已结束或被新问题替换，请重新查询当前状态', { sessionId });
    const toolId = binding.interaction.source.toolId;
    if (toolId) {
      const sources = new Set<string>();
      for (const round of view.pipeline.render?.rounds ?? [])
        for (const item of round.agentItems) {
          if (sourceToolId(item) === toolId)
            sources.add(
              `${item.source?.messageId ?? item.payload.messageId}:${item.source?.contentId ?? item.payload.contentId}`,
            );
        }
      for (const message of view.pipeline.messages)
        for (const content of message.displayContents) {
          if (object(object(content.tool).toolData).toolId === toolId)
            sources.add(
              `${message.messageId}:${text(content.contentId) ?? binding.interaction.source.contentId}`,
            );
        }
      sources.add(`${binding.interaction.source.messageId}:${binding.interaction.source.contentId}`);
      if (sources.size > 1)
        throw new CliError('AMBIGUOUS_INTERACTION', '同一工具标识对应多条消息，无法确定回复目标', {
          sessionId,
          interactionId,
        });
    }
    return object(await dispatchReply({ runtime: this, binding, input }));
  }
}
