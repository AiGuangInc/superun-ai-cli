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
import type { NodeRound, SessionView } from './contracts/node-wire.js';
import type { CreationResult, Choice } from './contracts/cli-output.js';
import { enabled, object, text } from './contracts/value.js';
import { getSuperunHostingDomain } from './config/runtime-config.js';
import type { JsonObject } from './contracts/value.js';
import { collectInteractions } from './interactions/registry.js';
import { toolId as sourceToolId, toolData } from './interactions/context.js';
import { integrationKey } from './interactions/handlers/reply-plugin.js';
import {
  isStyleSelected,
  projectChoices,
  styleBranchAnchor,
  styleChoiceLabel,
  styleWaitTarget,
} from './interactions/parsers/style-selection.js';
import type { StyleWaitTarget } from './interactions/parsers/style-selection.js';
import { resolveState } from './conversation/state-resolver.js';
import {
  buildNextActions,
  hasCompletedCreationResult,
  pendingStylePlanApproval,
} from './conversation/next-actions.js';
import {
  demoGenerationStatus,
  findModifiedDemoPreview,
  isInitialDemoRound,
  projectDemoPreview,
} from './conversation/demo-preview.js';
import type { GuidanceResult } from './conversation/next-actions.js';
import { currentRound, roundMessage, roundContainingMessage } from './conversation/round-selector.js';
import { SessionWaiter } from './conversation/session-waiter.js';
import type { WaitOptions } from './conversation/session-waiter.js';
import { CliError } from './output/exit-codes.js';
import { dispatchReply } from './interactions/handlers/index.js';
import { TaskProgressReader } from './conversation/task-progress-reader.js';
import { submittedTaskProgress, taskProgressSnapshot } from './conversation/task-progress.js';
import { autoTestContext, AUTO_TEST_SPEC } from './conversation/auto-test.js';
import { projectText } from './conversation/text-projector.js';
import { applySnapshot } from './conversation/session-waiter.js';
import { AutoTestTasks } from './conversation/auto-test-tasks.js';
import { codeReviewContext, CODE_REVIEW_SPEC } from './conversation/code-review.js';
import { readCheckQuestionContext } from './conversation/check-question-context.js';
import { checkContextFromExtra, reportReference } from './conversation/check-context.js';
import { styleResultNotice } from './conversation/style-guidance.js';
import { creditCode, throwCreditResult } from './conversation/insufficient-credits.js';
import { stylePlanningChoice } from './conversation/style-planning.js';
import { generateInitialStyles, appendStyle, retryStyle } from './conversation/style-generation.js';

// 仅独立演示版本等待快照同步，研发主线直接使用稳定预览地址。
const DEMO_SNAPSHOT_SYNC_MS = 15_000;

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
  readonly taskProgress: TaskProgressReader;
  readonly autoTestTasks: AutoTestTasks;
  private demoSnapshotSync?: { key: string; startedAt: number };
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
    this.taskProgress = new TaskProgressReader(client);
    this.autoTestTasks = new AutoTestTasks(client);
    this.waiter = new SessionWaiter({
      conversation: this.conversation,
      command: this.command,
      load: (id) => this.load(id),
      inspect: (view, styleTarget) => this.inspect(view, styleTarget),
      onProgress: (result) => {
        // 静默整理清单时不输出内部进度；真实业务提问仍照常返回。
        if (!result.stylePlanning || (result.interactions.length && !pendingStylePlanApproval(result)))
          this.output.progress(result);
      },
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
      // 对齐 Glow 的功能面板，读取当前文件而不是旧用户轮次的附件快照。
      view.features = await this.query.features(sessionId);
    }
    return view;
  }
  async choices(sessionId: string, anchor?: string, view?: SessionView): Promise<Array<Choice>> {
    const accessible = view ?? (await this.load(sessionId));
    const preReplyMessageId = anchor ?? styleBranchAnchor(accessible);
    if (!preReplyMessageId) return [];
    return projectChoices(
      await this.query.parallel(sessionId, preReplyMessageId),
      preReplyMessageId,
      this.client.config.endpoint,
    );
  }
  async inspect(view: SessionView, styleTarget?: StyleWaitTarget): Promise<CreationResult> {
    const { autoTest, codeReview } = await this.resolveChecks(view);
    const check = codeReview ?? autoTest;
    const anchor = styleTarget?.preReplyMessageId ?? styleBranchAnchor(view);
    const choices = anchor ? await this.choices(view.session.sessionId, anchor, view) : [];
    view = {
      ...view,
      activeSubagentWork: await this.taskProgress.hasPendingSubagentWork(view.session.sessionId),
    };
    const pendingReports = codeReview
      ? await this.taskProgress.pendingReviewReports(view, codeReview.previousSourceMessageId)
      : autoTest
        ? await this.autoTestTasks.pending(view)
        : [];
    if (pendingReports.length) view.activeSubagentWork = true;
    const bindings = collectInteractions(view, !styleTarget && isStyleSelected(view, choices)).filter(
      (binding) => !check || binding.interaction.kind !== 'SELECT_FEATURES',
    );
    const processingIds = new Set<string>();
    for (const binding of bindings) {
      if (binding.interaction.kind !== 'PLUGIN_ACTION') continue;
      const pluginName = text(toolData(binding.item).pluginName);
      if (!pluginName) continue;
      const state = await this.integration.status(view.session.sessionId, integrationKey(pluginName));
      if (['ENABLING', 'RESTORING', 'PAUSING', 'DISABLING'].includes(String(state.integrationStatus)))
        processingIds.add(binding.interaction.interactionId);
    }
    const visibleBindings = bindings.filter(
      (binding) => !processingIds.has(binding.interaction.interactionId),
    );
    const taskProgress = await this.taskProgress.read(
      view,
      choices,
      visibleBindings.map((binding) => binding.interaction),
      { autoTest: !!autoTest, codeReview: !!codeReview },
    );
    let result: CreationResult;
    try {
      result = resolveState(
        { ...view, automaticWork: processingIds.size > 0 },
        visibleBindings,
        choices,
        styleTarget,
      );
    } catch (error) {
      if (
        check &&
        error instanceof CliError &&
        error.code === 'BUSINESS_ERROR' &&
        !creditCode(error.details.errorType)
      ) {
        result = {
          state: 'FAILED',
          sessionId: view.session.sessionId,
          messageId: roundMessage(view, currentRound(view))?.messageId,
          replyMessageId: currentRound(view)?.anchorUserMessageId,
          messages: check.reportMessages,
          progress: [],
          interactions: [],
        };
        check.error = text(error.details.errorType) ?? error.message;
      } else if (error instanceof CliError) {
        const planningChoiceId = await stylePlanningChoice(view, this.query).catch(() => undefined);
        throw new CliError(error.code, error.message, {
          ...error.details,
          taskProgress,
          endpoint: this.client.config.endpoint,
          locale: this.client.config.locale,
          ...(planningChoiceId
            ? {
                instruction: `风格已选定，开发功能清单暂未整理完成：${error.message}。处理失败原因后回复“继续整理”，保留已选风格，通过 chat send 提交“继续整理开发功能清单”并等待结果，不重新生成或重复选择风格。`,
              }
            : {}),
        });
      } else throw error;
    }
    result.taskProgress = pendingReports.length
      ? taskProgressSnapshot(
          view.session.sessionId,
          [...new Map([...taskProgress.tasks, ...pendingReports].map((task) => [task.id, task])).values()],
          taskProgress.warnings,
        )
      : taskProgress;
    result.cursor = { ...result.cursor, progressRevision: result.taskProgress.revision };
    if (check) {
      // 审查和测试独立于开发阶段和功能推荐，不能落到普通研发完成菜单。
      const questionContext = await readCheckQuestionContext(this.client, view, result.interactions);
      if (questionContext.length) {
        result.messages = [
          ...new Map(
            [...result.messages, ...questionContext].map((message) => [message.id, message]),
          ).values(),
        ];
        check.reportMessages = [
          ...new Map(
            [...check.reportMessages, ...questionContext].map((message) => [message.id, message]),
          ).values(),
        ];
      }
      if (autoTest) result.autoTest = autoTest;
      if (codeReview) result.codeReview = codeReview;
      return result;
    }
    const roundExtra = roundMessage(view, currentRound(view))?.roundExtra ?? {};
    const planningChoiceId = await stylePlanningChoice(view, this.query);
    const started = enabled(roundExtra.startDevelopment);
    const planApproved = enabled(roundExtra.architecturePlanApproved);
    if (
      planningChoiceId &&
      !styleTarget &&
      isStyleSelected(view, choices) &&
      ((isInitialDemoRound(view) && !started) || (started && !planApproved))
    ) {
      result.stylePlanning = { choiceId: planningChoiceId };
      // 演示和规划都静默衔接，真正需要补充信息的问题仍按原文展示。
      if (
        ['RUNNING', 'QUEUED', 'COMPLETED', 'NEEDS_INPUT'].includes(result.state) &&
        (!result.interactions.length || pendingStylePlanApproval(result))
      ) {
        const choice = choices.find((item) => item.choiceId === planningChoiceId);
        result.messages = [
          {
            id: `${result.replyMessageId}:style-planning`,
            role: 'assistant',
            text: choice
              ? `已采用${styleChoiceLabel(choice)}，正在整理开发功能清单。`
              : '风格已选定，正在整理开发功能清单。',
          },
        ];
        if (result.taskProgress) {
          const roundId = currentRound(view)?.roundId;
          result.taskProgress = taskProgressSnapshot(
            view.session.sessionId,
            result.taskProgress.tasks.map((task) =>
              task.kind === 'message' && task.roundId === roundId
                ? { ...task, title: '整理开发功能清单', status: 'running', detail: undefined }
                : task,
            ),
            result.taskProgress.warnings,
          );
        }
      }
    }
    if (result.state === 'COMPLETED' && isStyleSelected(view, choices) && isInitialDemoRound(view)) {
      const message = roundMessage(view, currentRound(view));
      if (demoGenerationStatus(view) !== 2 || Number(message?.roundExtra?.demoReadyAt) > Date.now())
        return { ...result, state: 'RUNNING' };
      const demo = projectDemoPreview(await this.query.snapshots(view.session.sessionId), view, choices);
      // 不能用“消息完成”代替演示就绪，也不能拿另一种风格的最新快照兜底。
      if (!demo) return { ...result, state: 'RUNNING' };
      result.demo = demo;
    }
    const modifiedDemo =
      result.state === 'COMPLETED' &&
      !started &&
      !isInitialDemoRound(view) &&
      enabled(view.extra.hasViewedDemo) &&
      enabled(roundExtra.showConfirmGenerateMoreDemo);
    if (modifiedDemo) {
      result.demo = await findModifiedDemoPreview(this.query, view);
      if (result.demo) this.demoSnapshotSync = undefined;
      else {
        const key = `demo:${view.session.sessionId}:${currentRound(view)?.roundId}`;
        if (this.demoSnapshotSync?.key !== key) this.demoSnapshotSync = { key, startedAt: Date.now() };
        if (Date.now() - this.demoSnapshotSync.startedAt < DEMO_SNAPSHOT_SYNC_MS)
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
      if (result.development.stage === 'PLAN_REVIEW' && !result.stylePlanning)
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
        const sessionId = view.session.sessionId;
        if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,57}[a-zA-Z0-9])?$/.test(sessionId))
          throw new CliError('PROTOCOL_ERROR', '会话标识无法生成有效的预览地址');
        result.development.previewUrl = `https://id--${sessionId}.${getSuperunHostingDomain(this.client.config.endpoint)}`;
      }
    }
    return result;
  }
  async resolveChecks(view: SessionView): Promise<Pick<CreationResult, 'autoTest' | 'codeReview'>> {
    const current = currentRound(view);
    if (!current) return {};
    let sourceId = current.anchorUserMessageId;
    let sourceRound: NodeRound | undefined = current;
    const visited = new Set<string>();
    // 审查回投后可能再委派修复；逐层沿真实关联回溯，不能取最近的历史审查轮。
    for (let depth = 0; depth < 8; depth++) {
      if (visited.has(sourceId)) break;
      visited.add(sourceId);
      // 隐藏或并入其他轮的用户消息仍有持久化来源；单消息快照不保证返回渲染轮。
      const source: Awaited<ReturnType<AgentQueryApi['messageReferenceSource']>> | undefined = sourceRound
        ? undefined
        : await this.query.messageReferenceSource(view.session.sessionId, sourceId);
      const contexts = source
        ? {
            autoTest: checkContextFromExtra(source.roundExtra, AUTO_TEST_SPEC, sourceId),
            codeReview: checkContextFromExtra(source.roundExtra, CODE_REVIEW_SPEC, sourceId),
          }
        : {
            autoTest: autoTestContext(view, sourceId),
            codeReview: codeReviewContext(view, sourceId),
          };
      if (contexts.autoTest && contexts.codeReview)
        throw new CliError('PROTOCOL_ERROR', '当前结果同时关联审查与测试，无法确认来源');
      const check = contexts.codeReview ?? contexts.autoTest;
      if (check) {
        if (check.previousSourceMessageId) {
          const readPrevious = (source: SessionView) => {
            const round = roundContainingMessage(source, check.previousSourceMessageId!);
            return round
              ? projectText([round]).messages.filter((item) => item.role === 'assistant')
              : undefined;
          };
          let previous = readPrevious(view);
          if (!previous) {
            const snapshot = await this.conversation.snapshot(
              view.session.sessionId,
              check.previousSourceMessageId,
            );
            if (snapshot.pipeline) previous = readPrevious(applySnapshot(view, snapshot.pipeline));
          }
          check.previousReportMessages = previous;
        }
        check.sourceMessageId = current.anchorUserMessageId;
        check.reportMessages = projectText([current]).messages.filter((item) => item.role === 'assistant');
        return contexts;
      }
      const reference: ReturnType<typeof reportReference> = source ? reportReference(source) : undefined;
      const childId: string | undefined =
        reference && 'childId' in reference
          ? reference.childId
          : sourceRound?.meta?.subAgentReport
            ? text(sourceRound.meta.subAgentReportFrom)
            : undefined;
      const parentId: string | undefined = childId
        ? await this.taskProgress.parentReplyMessageId(view.session.sessionId, childId)
        : reference && 'taskId' in reference
          ? await this.autoTestTasks.parentForTask(view.session.sessionId, reference.taskId)
          : sourceRound
            ? await this.autoTestTasks.reportParent(view, sourceId)
            : undefined;
      if (!parentId) {
        const businessType =
          source?.roundExtra.business_type ??
          view.pipeline.messages.find((message) => message.messageId === sourceId)?.roundExtra?.business_type;
        if (
          reference ||
          sourceRound?.meta?.subAgentReport ||
          businessType === 'background_task_report' ||
          businessType === 'sub_agent_report'
        )
          throw new CliError('PROTOCOL_ERROR', '暂时无法读取后台回执的来源，请重新查询当前状态');
        return {};
      }
      sourceId = parentId;
      // 合并轮内可能有多次委派；此时按精确消息回溯，不能用宿主轮覆盖它的来源。
      sourceRound = view.pipeline.render?.rounds.find((round) => round.anchorUserMessageId === parentId);
    }
    throw new CliError('PROTOCOL_ERROR', '后台回执的来源链存在循环或层数过多，无法确认当前结果');
  }
  async state(sessionId: string): Promise<CreationResult> {
    return this.withGuidance(await this.inspect(await this.load(sessionId)));
  }
  withGuidance<T extends GuidanceResult>(result: T) {
    throwCreditResult(result, this.client.config);
    if (result.styleGeneration)
      result = {
        ...result,
        styleGeneration: { ...result.styleGeneration, notice: styleResultNotice(result) },
      };
    // 对外仍表示正在整理清单；内部保留真实确认交互，由 wait 校验后继续。
    const visible = pendingStylePlanApproval(result)
      ? {
          ...result,
          state: 'RUNNING' as const,
          interactions: [],
          development: result.development ? { ...result.development, stage: 'PLANNING' as const } : undefined,
        }
      : result;
    const output = visible.taskProgress
      ? { ...visible, cursor: { ...visible.cursor, progressRevision: visible.taskProgress.revision } }
      : visible;
    const completed = {
      ...output,
      ...(hasCompletedCreationResult(visible)
        ? { toolUsage: this.taskProgress.completionSummary(visible.sessionId, visible.messageId) }
        : {}),
    };
    return { ...completed, nextActions: buildNextActions(completed, this.client.config) };
  }
  async wait(sessionId: string, options: WaitOptions): Promise<CreationResult> {
    const deadline = options.timeout === undefined ? undefined : Date.now() + options.timeout * 1000;
    const remaining = () =>
      deadline === undefined ? undefined : Math.max(0, (deadline - Date.now()) / 1000);
    let pending = options;
    let result = await this.waiter.wait(sessionId, { ...pending, timeout: remaining() });
    while (result.stylePlanning && (result.state === 'COMPLETED' || pendingStylePlanApproval(result))) {
      if (deadline !== undefined && Date.now() >= deadline)
        return this.withGuidance({
          ...result,
          state: pendingStylePlanApproval(result) ? result.state : 'RUNNING',
          waitTimedOut: true,
        });
      const choiceId = result.stylePlanning.choiceId;
      const approval = pendingStylePlanApproval(result);
      let response: JsonObject;
      if (approval) response = await this.approveStylePlan(sessionId, choiceId, approval.interactionId);
      else {
        result = await this.viewDemo(sessionId, { timeout: remaining() }, choiceId);
        if (!result.stylePlanning || result.state !== 'COMPLETED') break;
        if (deadline !== undefined && Date.now() >= deadline)
          return this.withGuidance({ ...result, state: 'RUNNING', waitTimedOut: true });
        // 查看演示与进入研发各自先核对当前轮，失败时保留真实错误，不重发写请求。
        response = await this.startDevelopment(sessionId, choiceId);
      }
      pending = {
        messageId: text(response.messageId),
        requiredMessageId: text(response.messageId) ?? text(response.replyMessageId),
        progressRevision: result.taskProgress?.revision,
      };
      result = await this.waiter.wait(sessionId, { ...pending, timeout: remaining() });
    }
    // 最终展示功能清单或实际业务问题，静默步骤的消息不带到下一阶段。
    return this.withGuidance(result);
  }

  private async approveStylePlan(
    sessionId: string,
    choiceId: string,
    interactionId: string,
  ): Promise<JsonObject> {
    const latest = await this.inspect(await this.load(sessionId));
    if (
      latest.stylePlanning?.choiceId !== choiceId ||
      pendingStylePlanApproval(latest)?.interactionId !== interactionId
    )
      throw new CliError('STALE_INTERACTION', '研发规划或当前问题已变化，请重新查询当前状态', { sessionId });
    return this.command.chat({
      sessionId,
      content: '确认研发规划',
      businessParams: { business_type: 'architecture_plan_approve' },
      // 自动衔接只消费本次初始规划，不影响后续独立的规划调整与确认。
      excludedInheritedRoundExtraKeys: ['cliPlanAfterStyle'],
    });
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
    const receipt = submittedTaskProgress(
      id,
      text(response.replyMessageId) ?? text(response.messageId) ?? id,
      text(response.planningNotice) ?? text(response.progressTitle) ?? '任务已提交',
    );
    let taskProgress = receipt;
    try {
      // 接受回执也展示同一项目的其他活跃任务；仅查进度，不推进任务或读取功能清单。
      const view: SessionView = { ...(await this.conversation.recently(id)), extra: {} };
      const snapshot = await this.taskProgress.read(view, await this.choices(id, undefined, view), [], {
        autoTest: ['test', 'repair'].includes(String(response.autoTestPhase)),
        codeReview: ['review', 'repair'].includes(String(response.codeReviewPhase)),
      });
      const responseIds = [text(response.messageId), text(response.replyMessageId)].filter(Boolean);
      const round = view.pipeline.render?.rounds.find(
        (item) =>
          responseIds.includes(item.anchorUserMessageId) ||
          [...item.userItems, ...item.agentItems].some((content) =>
            responseIds.includes(content.source?.messageId),
          ),
      );
      const observed = round && snapshot.tasks.some((task) => task.roundId === round.roundId);
      taskProgress = taskProgressSnapshot(
        id,
        [...snapshot.tasks, ...(observed ? [] : receipt.tasks)],
        snapshot.warnings,
      );
    } catch {
      taskProgress = taskProgressSnapshot(id, receipt.tasks, [
        '请求已接受，其他任务进度暂未读取，请继续查询。',
      ]);
    }
    return this.withGuidance({
      state: 'ACCEPTED',
      sessionId: id,
      messageId: text(response.messageId),
      replyMessageId: text(response.replyMessageId),
      messages: text(response.styleNotice)
        ? [{ id: `${id}:style-generation`, role: 'assistant' as const, text: String(response.styleNotice) }]
        : text(response.planningNotice)
          ? [
              {
                id: `${id}:style-planning`,
                role: 'assistant' as const,
                text: String(response.planningNotice),
              },
            ]
          : [],
      progress: [],
      interactions: [],
      taskProgress,
      ...(text(response.planningChoiceId)
        ? { stylePlanning: { choiceId: String(response.planningChoiceId) } }
        : {}),
      cursor: { branchAnchor: text(response.preReplyMessageId) },
      ...(styleWaitTarget(response)
        ? {
            styleGeneration: {
              choiceIds: styleWaitTarget(response)!.choiceIds,
              phase: (text(response.stylePhase) ?? 'initial') as 'initial' | 'append' | 'retry',
              notice: text(response.styleNotice),
            },
          }
        : {}),
      ...(['test', 'repair'].includes(String(response.autoTestPhase))
        ? {
            autoTest: {
              phase: response.autoTestPhase as 'test' | 'repair',
              sourceMessageId: text(response.replyMessageId) ?? text(response.messageId) ?? '',
              reportMessages: [],
            },
          }
        : {}),
      ...(['review', 'repair'].includes(String(response.codeReviewPhase))
        ? {
            codeReview: {
              phase: response.codeReviewPhase as 'review' | 'repair',
              sourceMessageId: text(response.replyMessageId) ?? text(response.messageId) ?? '',
              reportMessages: [],
            },
          }
        : {}),
    });
  }
  async generateStyles(sessionId: string, content: string, preReplyMessageId?: string): Promise<JsonObject> {
    return generateInitialStyles(this, sessionId, content, preReplyMessageId);
  }
  async appendStyle(sessionId: string, anchor: string): Promise<JsonObject> {
    return appendStyle(this, sessionId, anchor);
  }
  async retryStyle(sessionId: string, choiceId: string): Promise<JsonObject> {
    return retryStyle(this, sessionId, choiceId);
  }
  async selectStyle(sessionId: string, choiceId: string): Promise<JsonObject> {
    const view = await this.load(sessionId);
    if (!view.session.pendingBranch || isStyleSelected(view))
      throw new CliError('STALE_INTERACTION', '当前已离开风格选择阶段，请查看进度');
    const choice = (await this.choices(sessionId, undefined, view)).find(
      (item) => item.choiceId === choiceId,
    );
    if (!choice)
      throw new CliError('STALE_INTERACTION', '当前未决批次中不存在该风格，请重新执行 chat style list');
    if (choice.status !== 'success' || choice.errorType)
      throw new CliError('INVALID_ARGUMENT', '只能选择成功生成的风格');
    if (choice.selected)
      throw new CliError('STALE_INTERACTION', '该风格已经选中，请通过 chat wait 继续当前流程，勿重复选择', {
        sessionId,
      });
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
      roundExtra: { ...stageExtra, cliPlanAfterStyle: choice.choiceId, business_type: 'choose_style_v2' },
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
    const planningNotice = `已采用${styleChoiceLabel(choice)}，正在整理开发功能清单。`;
    this.output.log(planningNotice);
    return { ...response, planningChoiceId: choice.choiceId, planningNotice };
  }
  async viewDemo(
    sessionId: string,
    options: WaitOptions = {},
    planningChoiceId?: string,
  ): Promise<CreationResult> {
    const view = await this.load(sessionId);
    const round = currentRound(view);
    const extra = roundMessage(view, round)?.roundExtra ?? {};
    const currentChoiceId = await stylePlanningChoice(view, this.query);
    if (planningChoiceId && currentChoiceId !== planningChoiceId)
      throw new CliError('STALE_INTERACTION', '风格衔接期间会话已切换，请查询当前状态', { sessionId });
    const result = await this.inspect(view);
    if (planningChoiceId && enabled(extra.startDevelopment)) return this.withGuidance(result);
    // 已有查看轮时只等待其结果，不重复发送查看消息。
    if (
      round &&
      extra.business_type === 'fake_confirm_generate_more_demo' &&
      !enabled(extra.startDevelopment)
    ) {
      if (!enabled(view.extra.hasViewedDemo))
        await this.command.sessionExtra(sessionId, { hasViewedDemo: '1' });
      return this.waitForDemoView(sessionId, round.anchorUserMessageId, options);
    }
    if (result.state !== 'COMPLETED' || !result.demo)
      throw new CliError('INVALID_ARGUMENT', '当前演示尚不可查看，请先查询并等待当前任务完成', { sessionId });
    // 查看与选择是两个动作；只在取得对应演示快照后记录已查看。
    if (!enabled(view.extra.hasViewedDemo) || Number(view.extra.demoGenerateStatus) !== 2)
      await this.command.sessionExtra(sessionId, { hasViewedDemo: '1', demoGenerateStatus: '2' });
    if (
      Number(view.extra.version) >= 4 &&
      !enabled(extra.showConfirmGenerateMoreDemo) &&
      !enabled(extra.generateDemo) &&
      !enabled(extra.startDevelopment)
    ) {
      const response = await this.command.viewDemo(sessionId, currentChoiceId);
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
      return this.waitForDemoView(sessionId, messageId, options);
    }
    return this.withGuidance({
      ...result,
      demo: { ...result.demo, viewed: true },
      development: { stage: 'READY', started: false, planApproved: false },
    });
  }
  private async waitForDemoView(
    sessionId: string,
    messageId: string,
    options: WaitOptions = {},
  ): Promise<CreationResult> {
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
    return this.withGuidance(await waiter.wait(sessionId, { messageId, timeout: options.timeout }));
  }
  async startDevelopment(sessionId: string, planningChoiceId?: string): Promise<JsonObject> {
    const view = await this.load(sessionId);
    const extra = roundMessage(view, currentRound(view))?.roundExtra ?? {};
    const currentChoiceId = await stylePlanningChoice(view, this.query);
    if (planningChoiceId && currentChoiceId !== planningChoiceId)
      throw new CliError('STALE_INTERACTION', '风格衔接期间会话已切换，请查询当前状态', { sessionId });
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
      roundExtra: {
        startDevelopment: '1',
        showDismissInBuildTutorial: '0',
        ...(currentChoiceId ? { cliPlanAfterStyle: currentChoiceId } : {}),
      },
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
