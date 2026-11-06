/** 全托管的只读观察与现有收费/恢复接口，不接管普通创作运行时。@author xiuyu.yi */
import type { Command } from 'commander';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CommandContext } from '../shared.js';
import { runtime, positive, readInput } from '../shared.js';
import type { CreationRuntime } from '../../runtime.js';
import { AutoModeApi, managedEntryNotice } from '../../api/auto-mode-api.js';
import type { AutoModeStatus } from '../../api/auto-mode-api.js';
import { COMMAND_NAME } from '../../config/constants.js';
import { getSuperunHostingDomain } from '../../config/runtime-config.js';
import { object, text, enabled } from '../../contracts/value.js';
import { projectText } from '../../conversation/text-projector.js';
import { currentRound, roundMessage } from '../../conversation/round-selector.js';
import { readProjectRouting } from '../../conversation/project-routing.js';
import { CliError } from '../../output/exit-codes.js';

const REPORT = 'artifacts/auto-mode-summary.md';
const CONTINUATION = ['推荐更多功能', '手动输入需求', '上线运营'];
type Scope = { runId?: string; startedAt?: number; completedAt?: number; entryMessageId?: string };
const numberOption = (value: unknown) => (typeof value === 'number' ? value : undefined);
function tokenAmount(value: string) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError('INVALID_ARGUMENT', '实际解锁金额必须为非负安全整数最小单位');
  return Number(value);
}
function projectUrl(service: CreationRuntime, sessionId: string) {
  return new URL(`/web/project/${encodeURIComponent(sessionId)}`, service.client.config.endpoint).href;
}
function commandFor(service: CreationRuntime, operation: string, sessionId: string, options: string[] = []) {
  return [
    COMMAND_NAME,
    '--endpoint',
    service.client.config.endpoint,
    '--locale',
    service.client.config.locale,
    'chat',
    'auto-mode',
    operation,
    ...options,
    '--',
    sessionId,
  ];
}
function scopeOf(state: AutoModeStatus, options: Scope = {}) {
  if (options.runId && options.runId !== state.runId)
    throw new CliError('STALE_INTERACTION', '当前托管运行与本次回执不一致');
  const start = state.startedAt ?? options.startedAt,
    end = state.completedAt ?? options.completedAt;
  if (
    (start != null && (!Number.isSafeInteger(start) || start < 1)) ||
    (end != null && (!Number.isSafeInteger(end) || end < 1 || (start != null && end < start)))
  )
    throw new CliError('INVALID_ARGUMENT', '托管时间边界无效，请使用本次真实运行回执');
  return {
    runId: state.runId ?? undefined,
    startedAt: state.startedAt ?? options.startedAt,
    completedAt: state.completedAt ?? options.completedAt,
    entryMessageId: options.entryMessageId,
  };
}
function historyOptions(scope: Scope) {
  return [
    ...(scope.runId ? ['--run-id', scope.runId] : []),
    ...(scope.startedAt != null ? ['--started-at', String(scope.startedAt)] : []),
    ...(scope.completedAt != null ? ['--completed-at', String(scope.completedAt)] : []),
    ...(scope.entryMessageId ? ['--entry-message-id', scope.entryMessageId] : []),
  ];
}
function metrics(state: AutoModeStatus) {
  const minor = state.billingMode === 'NORMAL' ? state.chargedTokenAmount : state.consumedTokenAmount;
  return {
    consumedCredits: minor != null && state.tokenRate ? minor / state.tokenRate : undefined,
    amountMinor: minor ?? undefined,
    tokenRate: state.tokenRate ?? undefined,
    durationMs: state.workSummary?.durationMs ?? undefined,
    toolCallCount: state.workSummary?.toolCallCount ?? undefined,
    subTaskCount: state.workSummary?.subTaskCount ?? undefined,
    billingPending: state.billingPending ?? true,
  };
}
async function observe(
  service: CreationRuntime,
  sessionId: string,
  options: Scope = {},
  untilAnchor?: string,
  fullHistory = false,
  snapshot?: AutoModeStatus,
) {
  const api = new AutoModeApi(service.client),
    managed = await api.status(sessionId);
  const scope = scopeOf(managed, options);
  const [recent, extra] = await Promise.all([
    service.conversation.recently(sessionId),
    service.query.extra(sessionId),
  ]);
  if (recent.session.sessionId !== sessionId)
    throw new CliError('PROTOCOL_ERROR', '项目读取返回了不同的会话，未展示其他项目结果');
  let pipeline = recent.pipeline;
  const rounds = pipeline.render?.rounds ?? [];
  if (
    (fullHistory || (untilAnchor && !rounds.some((r) => r.anchorUserMessageId === untilAnchor))) &&
    scope.startedAt != null
  ) {
    pipeline = await api.history(
      sessionId,
      scope.startedAt,
      scope.completedAt ?? undefined,
      untilAnchor,
      scope.entryMessageId,
    );
  }
  const view = { ...recent, pipeline, extra };
  const visibleRounds = (pipeline.render?.rounds ?? []).filter(
    (r) =>
      !r.meta?.consult &&
      !r.meta?.passive &&
      (scope.startedAt == null ||
        r.time.timestamp >= scope.startedAt ||
        r.anchorUserMessageId === scope.entryMessageId) &&
      (scope.completedAt == null || r.time.timestamp <= scope.completedAt),
  );
  const projected = projectText(visibleRounds);
  const messages =
    managed.completionVerified && scope.startedAt == null
      ? []
      : projected.messages.filter((m) => m.role === 'assistant');
  const taskProgress =
    managed.autoMode === 1 && ['RUNNING', 'WAITING_CALLBACK'].includes(managed.status ?? '')
      ? await service.taskProgress.read(view, [])
      : undefined;
  const currentView = { ...recent, extra };
  const head = currentRound(currentView),
    roundExtra = roundMessage(currentView, head)?.roundExtra ?? {};
  const canPreview =
    head?.status === 'completed' &&
    enabled(roundExtra.startDevelopment) &&
    enabled(roundExtra.architecturePlanApproved) &&
    !['start_dev', 'architecture_plan_approve'].includes(String(roundExtra.business_type));
  let previewUrl: string | undefined;
  if (canPreview && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,57}[a-zA-Z0-9])?$/.test(sessionId))
    previewUrl = `https://id--${sessionId}.${getSuperunHostingDomain(service.client.config.endpoint)}`;
  const routing = previewUrl ? await readProjectRouting(service.query, previewUrl, { sessionId }) : undefined;
  const done = managed.status === 'DONE' || managed.completionVerified;
  const attachments = done ? await service.query.attachments(sessionId, [REPORT]) : [];
  const report = attachments.find((item) => item.name === REPORT && typeof item.content === 'string');
  const phase = managed.completionVerified
    ? 'CONTINUING'
    : managed.exited
      ? 'EXITED'
      : managed.status === 'DONE'
        ? 'MANAGED_DONE'
        : managed.status === 'PAUSED'
          ? 'MANAGED_PAUSED'
          : 'MANAGED_RUNNING';
  const nextActions =
    phase === 'MANAGED_DONE'
      ? [
          {
            action: 'PREPARE_COMPLETION',
            requiresUserInput: false,
            command: commandFor(service, 'quote', sessionId, ['--run-id', scope.runId!]),
            instruction:
              '交付说明、真实预览和四项统计后，读取实际报价并附在现有完成选项说明中；这只是查询，不能自动购买。随后用原生单选展示“完成托管，继续创作／查看完成报告／创作历程”。当前不开放手动新需求输入。',
          },
          {
            action: 'VIEW_REPORT',
            requiresUserInput: true,
            command: commandFor(service, 'report', sessionId, historyOptions(scope)),
            instruction: '展示本次原始完成报告，随后直接引导“完成托管，继续创作”，不追加建议或自动结束托管。',
          },
          {
            action: 'VIEW_HISTORY',
            requiresUserInput: true,
            command: commandFor(service, 'history', sessionId, historyOptions(scope)),
            instruction: '只读展示本次真实创作历程，随后直接引导“完成托管，继续创作”，不执行历史 CTA。',
          },
        ]
      : phase === 'MANAGED_PAUSED'
        ? [
            {
              action: 'RESUME_AUTO_MODE',
              requiresUserInput: true,
              url: projectUrl(service, sessionId),
              instruction: '说明暂停原因，引导用户到项目详情页继续全托管。',
            },
          ]
        : phase === 'CONTINUING'
          ? [
              {
                action: 'CONTINUE_CREATION',
                requiresUserInput: true,
                options: CONTINUATION,
                instruction:
                  '先再次交付本项目当前真实 id--预览和全部端入口，再用原生单选按顺序展示“推荐更多功能／手动输入需求／上线运营”。选项标签只填名称，不手工添加序号，编号由控件显示。不要增加是否已有需求判断。后续使用既有研发、QA、发布、高级设计师和 Agent 友好命令及实际 nextActions.when；每次业务写入前先 require-completed 核对同一运行。',
              },
            ]
          : [];
  return {
    state: done
      ? 'COMPLETED'
      : phase === 'MANAGED_PAUSED'
        ? 'PAUSED'
        : phase === 'EXITED'
          ? 'INTERRUPTED'
          : 'RUNNING',
    sessionId,
    managedPhase: phase,
    managed,
    scope,
    entryNotice: managedEntryNotice(managed.billingMode),
    messages,
    progress: projected.progress,
    executionActivity: await service.executionActivity.read(view, {
      rounds: visibleRounds,
      runId: scope.runId,
      anchorUserMessageId: scope.entryMessageId,
    }),
    taskProgress,
    delivery: { previewUrl, routing, report: report?.content, reportPending: done && !report },
    metrics: metrics(snapshot ?? managed),
    allowNewRequirement: managed.completionVerified,
    nextActions,
    anchor: currentRound({ ...recent, extra })?.anchorUserMessageId,
  };
}
function scopeOptions(command: Command) {
  return command
    .option('--run-id <runId>', '绑定本次真实托管运行')
    .option('--started-at <milliseconds>', '本次托管开始时间，使用原回执值', positive)
    .option('--completed-at <milliseconds>', '本次托管完成时间，使用原回执值', positive)
    .option('--entry-message-id <messageId>', '本次创建回执的用户消息锚点');
}
function readScope(command: Command): Scope {
  const options = object(command.opts());
  return {
    runId: text(options.runId),
    startedAt: numberOption(options.startedAt),
    completedAt: numberOption(options.completedAt),
    entryMessageId: text(options.entryMessageId),
  };
}

export function registerAutoMode(chat: Command, context: CommandContext) {
  const auto = chat.command('auto-mode').description('查看全托管状态、进展和报价；恢复及解锁请到项目详情页');
  for (const name of ['status', 'report', 'history']) {
    scopeOptions(
      auto
        .command(`${name} <sessionId>`)
        .description(
          name === 'status'
            ? '只读查询本次托管状态与对话'
            : name === 'report'
              ? '只读交付本次说明、预览和四项统计'
              : '只读重建本次托管历程',
        ),
    ).action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        scope = readScope(command);
      if (name === 'history') {
        const state = await new AutoModeApi(service.client).status(sessionId),
          resolved = scopeOf(state, scope);
        if (
          !resolved.runId ||
          resolved.startedAt == null ||
          (state.completionVerified && resolved.completedAt == null)
        )
          throw new CliError(
            'INVALID_ARGUMENT',
            '完整历程需要本次 run-id 和起止时间，结束后请使用原托管回执，不能混入后续创作',
          );
      }
      const result = await observe(service, sessionId, scope, undefined, name === 'history');
      context.output.execution(result);
      context.output.write(result);
    });
  }
  scopeOptions(
    auto.command('wait <sessionId>').description('只读观察整次托管，持续交付对话和进度，不推进普通阶段'),
  )
    .option('--timeout <seconds>', '本地等待上限，到时返回仍在进行', positive)
    .option('--interval <seconds>', '只读查询最小间隔', positive, 3)
    .option('--cursor <file>', '上一次本项目 wait 的最终 JSON 文件，只恢复已展示游标')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        options = object(command.opts());
      const deadline = options.timeout == null ? Infinity : Date.now() + Number(options.timeout) * 1000;
      const previous = options.cursor ? object(await readInput(String(options.cursor))) : {};
      const cursor = object(object(previous.data ?? previous).cursor);
      if (
        options.cursor &&
        (cursor.sessionId !== sessionId ||
          !text(cursor.runId) ||
          (options.runId && cursor.runId !== options.runId))
      )
        throw new CliError('INVALID_ARGUMENT', '等待游标不属于当前项目，未复用其他任务结果');
      const shown = new Map<string, string>();
      for (const entry of Array.isArray(cursor.shownMessages) ? cursor.shownMessages : []) {
        const value = object(entry);
        if (text(value.id) && text(value.revision)) shown.set(String(value.id), String(value.revision));
      }
      let scope: Scope = {
        runId: text(cursor.runId),
        startedAt: numberOption(cursor.startedAt),
        completedAt: numberOption(cursor.completedAt),
        entryMessageId: text(cursor.entryMessageId),
        ...Object.fromEntries(Object.entries(readScope(command)).filter(([, value]) => value !== undefined)),
      };
      let anchor = text(cursor.anchor),
        progressRevision = text(cursor.progressRevision);
      while (true) {
        const value = await observe(service, sessionId, scope, anchor, !anchor);
        scope = value.scope;
        const messages = value.messages.filter((message) => {
          const revision = createHash('sha256').update(message.text).digest('hex');
          if (shown.get(message.id) === revision) return false;
          shown.set(message.id, revision);
          return true;
        });
        context.output.execution(value, shown);
        if (messages.length)
          context.output.log(
            JSON.stringify({
              schemaVersion: '1',
              event: 'conversation_message',
              data: { sessionId, messages },
              instruction: '及时展示本次全托管的真实回复，按消息 id 更新；这是过程事件，不表示整次完成。',
            }),
          );
        const revision = value.taskProgress?.revision;
        if (value.taskProgress && revision !== progressRevision)
          context.output.progress({ sessionId, taskProgress: value.taskProgress });
        progressRevision = revision;
        anchor = value.anchor;
        const waiting =
          value.managedPhase === 'MANAGED_RUNNING' ||
          (value.managedPhase === 'MANAGED_DONE' && value.delivery.reportPending);
        if (!waiting || Date.now() >= deadline) {
          context.output.write({
            ...value,
            ...(waiting ? { state: 'RUNNING' } : {}),
            waitTimedOut: waiting && Date.now() >= deadline,
            cursor: {
              sessionId,
              ...scope,
              anchor,
              progressRevision,
              shownMessages: [...shown].map(([id, revision]) => ({ id, revision })),
            },
          });
          return;
        }
        try {
          await delay(Number(options.interval) * 1000, undefined, { signal: context.signal });
        } catch {
          throw new CliError('INTERRUPTED', '已停止本地等待，云端全托管不受影响', {
            sessionId,
            runId: scope.runId,
          });
        }
      }
    });
  auto
    .command('retry <sessionId>')
    .description('暂停的全托管任务请在项目详情页恢复')
    .requiredOption('--run-id <runId>', '本次托管运行标识')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        api = new AutoModeApi(service.client);
      await api.retry(sessionId, String(command.opts().runId));
      context.output.write({
        state: 'ACCEPTED',
        sessionId,
        runId: command.opts().runId,
        nextActions: [
          {
            action: 'WAIT_AUTO_MODE',
            requiresUserInput: false,
            command: commandFor(service, 'wait', sessionId, ['--run-id', String(command.opts().runId)]),
          },
        ],
      });
    });
  auto
    .command('quote <sessionId>')
    .description('读取当前真实费用，准备现有完成托管入口，不购买')
    .requiredOption('--run-id <runId>', '本次托管运行标识')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        runId = String(command.opts().runId);
      const quote = await new AutoModeApi(service.client).quote(sessionId, runId);
      const project = (await service.conversation.recently(sessionId)).session;
      if (project.sessionId !== sessionId)
        throw new CliError('PROTOCOL_ERROR', '费用对应的项目读取不一致，未准备付款动作');
      if (typeof project.workspaceId === 'number' && !Number.isSafeInteger(project.workspaceId))
        throw new CliError('PROTOCOL_ERROR', '项目扣费账户标识精度不可靠，未准备付款动作');
      const workspaceId = project.workspaceId == null ? '' : String(project.workspaceId).trim();
      const chargeAccount =
        workspaceId && workspaceId !== '0'
          ? {
              type: 'workspace',
              workspaceId,
              label: `团队账户：${text(project.workspaceName) ?? workspaceId}`,
            }
          : Object.hasOwn(project, 'workspaceId')
            ? { type: 'personal', label: '个人账户' }
            : { type: 'project', label: '本项目资金账户（以项目服务端归属为准）' };
      const purchase = quote.billingMode === 'FREE_TRIAL' && !quote.completionVerified;
      if (
        !quote.completionVerified &&
        ((quote.billingMode !== 'FREE_TRIAL' && quote.billingMode !== 'NORMAL') ||
          (quote.billingMode === 'NORMAL' &&
            (quote.billingPending !== false || quote.chargedTokenAmount == null)))
      )
        throw new CliError('INVALID_ARGUMENT', '本次计费状态或账单仍在同步，请先只读刷新');
      if (purchase && (quote.purchaseTokenAmount == null || !quote.tokenRate))
        throw new CliError('PROTOCOL_ERROR', '实际解锁价格尚未就绪，未准备付款动作');
      context.output.write({
        state: 'COMPLETED',
        sessionId,
        managed: quote,
        completionQuote: {
          paymentRequired: purchase,
          amountMinor: purchase ? quote.purchaseTokenAmount : 0,
          credits: purchase ? quote.purchaseTokenAmount! / quote.tokenRate! : 0,
          tokenRate: quote.tokenRate,
          chargeAccount,
          expiresAt: quote.expiresAt,
          serverTime: quote.serverTime,
        },
        nextActions: quote.completionVerified
          ? []
          : [
              {
                action: 'COMPLETE_AUTO_MODE',
                requiresUserInput: true,
                url: projectUrl(service, sessionId),
                instruction: '展示当前报价和扣费账户，由用户在项目详情页确认解锁。',
              },
            ],
      });
    });
  auto
    .command('complete <sessionId>')
    .description('购买或解锁请到项目详情页；已解锁可回读结果')
    .requiredOption('--run-id <runId>', '本次托管运行标识')
    .option('--expected-token-amount <minor>', '用户已看到并授权的当前解锁金额最小单位', tokenAmount)
    .option('--acknowledge-purchase', '本次实际金额已向用户展示并取得付款授权')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        options = object(command.opts());
      const receipt = await new AutoModeApi(service.client).complete(
        sessionId,
        String(options.runId),
        numberOption(options.expectedTokenAmount),
        options.acknowledgePurchase === true,
      );
      const before = receipt.before;
      const quote = 'quote' in receipt ? receipt.quote : undefined;
      // 报价的本次消耗可能比异步账单更新；只补金额和倍率，保留解锁前的整次工作量。
      const snapshot = quote
        ? {
            ...before,
            consumedTokenAmount: quote.consumedTokenAmount ?? before.consumedTokenAmount,
            tokenRate: quote.tokenRate ?? before.tokenRate,
          }
        : before;
      const scope = {
        runId: String(options.runId),
        startedAt: before.startedAt ?? undefined,
        completedAt: before.completedAt ?? undefined,
      };
      try {
        const value = await observe(service, sessionId, scope, undefined, false, snapshot);
        context.output.write({ ...value, completionReceipt: receipt });
      } catch {
        // 收费及模式切换已经核对成功；交付读取失败只补查，不能诱导重新购买。
        context.output.write({
          state: 'COMPLETED',
          sessionId,
          managedPhase: 'CONTINUING',
          managed: receipt.after,
          completionReceipt: receipt,
          scope,
          metrics: metrics(snapshot),
          deliveryPending: true,
          nextActions: [
            {
              action: 'READ_DELIVERY',
              requiresUserInput: false,
              command: commandFor(service, 'report', sessionId, historyOptions(scope)),
              instruction:
                '收费和完成托管已成功，预览或报告暂未同步，只读补查；不要重复购买。取得实际预览后再显示固定三选项。',
            },
          ],
        });
      }
    });
  auto
    .command('require-completed <sessionId>')
    .description('新专家团后续业务前只读核对收费和完成状态，不自动扣款')
    .requiredOption('--run-id <runId>', '绑定的本次托管运行')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        api = new AutoModeApi(service.client),
        state = await api.status(sessionId);
      api.assertRun(state, String(command.opts().runId));
      if (!state.completionVerified)
        throw new CliError(
          'INVALID_ARGUMENT',
          '请先通过“完成托管，继续创作”完成正常收费和托管处理，当前不开放新需求',
          { sessionId, managed: state },
        );
      context.output.write({
        state: 'COMPLETED',
        sessionId,
        managed: state,
        allowNewRequirement: true,
        options: CONTINUATION,
      });
    });
}
