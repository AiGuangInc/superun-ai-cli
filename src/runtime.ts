/** 组织项目创作、交互回复和任务查询。@author xiuyu.yi */
import { AgentCommandApi } from './api/agent-command-api.js';
import { AgentQueryApi } from './api/agent-query-api.js';
import { ConfigApi } from './api/config-api.js';
import { ConversationApi } from './api/conversation-api.js';
import { IntegrationApi } from './api/integration-api.js';
import { PluginApi } from './api/plugin-api.js';
import { PublishApi } from './api/publish-api.js';
import type { ApiClient } from './transport/api-client.js';
import type { OutputWriter } from './output/writer.js';
import type { SessionView } from './contracts/node-wire.js';
import type { CreationResult, Choice } from './contracts/cli-output.js';
import { object, text } from './contracts/value.js';
import type { JsonObject } from './contracts/value.js';
import { collectInteractions } from './interactions/registry.js';
import { toolId as sourceToolId, toolData } from './interactions/context.js';
import { integrationKey } from './interactions/handlers/reply-plugin.js';
import { projectChoices } from './interactions/parsers/style-selection.js';
import { resolveState } from './conversation/state-resolver.js';
import { currentRound, roundMessage } from './conversation/round-selector.js';
import { SessionWaiter } from './conversation/session-waiter.js';
import type { WaitOptions } from './conversation/session-waiter.js';
import { CliError } from './output/exit-codes.js';
import { dispatchReply } from './interactions/handlers/index.js';

export class CreationRuntime {
  readonly command: AgentCommandApi;
  readonly query: AgentQueryApi;
  readonly config: ConfigApi;
  readonly conversation: ConversationApi;
  readonly integration: IntegrationApi;
  readonly plugin: PluginApi;
  readonly publish: PublishApi;
  readonly waiter: SessionWaiter;
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
    this.waiter = new SessionWaiter({
      conversation: this.conversation,
      command: this.command,
      load: (id) => this.load(id),
      inspect: (view) => this.inspect(view),
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
      !object(message.extra).featureListConfirmed
    ) {
      view.features = await this.query.features(sessionId, round?.anchorUserMessageId);
    }
    return view;
  }
  async choices(sessionId: string, anchor?: string, view?: SessionView): Promise<Array<Choice>> {
    const accessible = view ?? (await this.load(sessionId));
    const preReplyMessageId = anchor ?? accessible.session.pendingBranch?.preReplyMessageId;
    if (!preReplyMessageId) return [];
    return projectChoices(await this.query.parallel(sessionId, preReplyMessageId), preReplyMessageId);
  }
  async inspect(view: SessionView): Promise<CreationResult> {
    const choices = view.session.pendingBranch
      ? await this.choices(view.session.sessionId, undefined, view)
      : [];
    const bindings = collectInteractions(view);
    const processingIds = new Set<string>();
    for (const binding of bindings) {
      if (binding.interaction.kind !== 'PLUGIN_ACTION') continue;
      const pluginName = text(toolData(binding.item).pluginName);
      if (!pluginName) continue;
      const state = await this.integration.status(view.session.sessionId, integrationKey(pluginName));
      if (['ENABLING', 'RESTORING', 'PAUSING', 'DISABLING'].includes(String(state.integrationStatus)))
        processingIds.add(binding.interaction.interactionId);
    }
    return resolveState(
      { ...view, automaticWork: processingIds.size > 0 },
      bindings.filter((binding) => !processingIds.has(binding.interaction.interactionId)),
      choices,
    );
  }
  async state(sessionId: string): Promise<CreationResult> {
    return this.inspect(await this.load(sessionId));
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
      return this.waiter.wait(id, { ...options, messageId: text(response.messageId) ?? options.messageId });
    return {
      state: 'ACCEPTED',
      sessionId: id,
      messageId: text(response.messageId),
      replyMessageId: text(response.replyMessageId),
      messages: [],
      progress: [],
      interactions: [],
    };
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
  async selectStyle(sessionId: string, choiceId: string, retry = false): Promise<JsonObject> {
    const choice = (await this.choices(sessionId)).find((item) => item.choiceId === choiceId);
    if (!choice)
      throw new CliError('STALE_INTERACTION', '当前未决批次中不存在该风格，请重新执行 chat style list');
    if (retry) {
      if (choice.status !== 'failed') throw new CliError('INVALID_ARGUMENT', '只有失败风格可以重试');
      return this.command.retry(sessionId, choice.replyMessageId);
    }
    if (choice.status !== 'success' || choice.errorType)
      throw new CliError('INVALID_ARGUMENT', '只能选择成功生成的风格');
    return this.command.chat({
      sessionId,
      content: `选择风格 ${choice.index + 1}`,
      parallelSelectRequest: {
        sessionId,
        selectedReplyMessageId: choice.replyMessageId,
        selectedLastReplyMessageId: choice.lastReplyMessageId ?? choice.replyMessageId,
      },
      roundExtra: { hasSelectedStyle: '1', business_type: 'choose_style_v2' },
      businessParams: { business_type: 'choose_style_v2' },
    });
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
