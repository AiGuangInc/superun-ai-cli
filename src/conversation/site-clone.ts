/** 网站搬家状态与阶段切换。@author xiuyu.yi */
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import { parseWire } from '../contracts/node-wire.js';
import type { SessionView } from '../contracts/node-wire.js';
import type { CreationResult, SiteCloneProgress, NextAction } from '../contracts/cli-output.js';
import { enabled, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { currentRound, roundMessage } from './round-selector.js';
import { latestStyleChoices } from '../interactions/parsers/style-selection.js';
import { pendingAutomaticTools } from '../auto-tools/registry.js';
import { rechargeAction, retryableMainMessage } from './insufficient-credits.js';
import { collectInteractions } from '../interactions/registry.js';
import { projectText } from './text-projector.js';

const projectsSchema = z.array(
  z.object({
    sessionId: z.string(),
    status: z.number().int().min(0).max(9),
    createdAt: z.number().int().positive(),
  }),
);
const headSchema = z.object({
  sessionId: z.string(),
  headMessageId: z.string().nullish(),
  headReplyMessageId: z.string().nullish(),
  headMessageStatus: z.number().nullish(),
  roundExtra: z.record(z.string()),
});

export function siteCloneWeeklyDecision(
  value: unknown,
): NonNullable<SiteCloneProgress['weeklyFreeDecision']> {
  return value === '1' || value === 1 ? 'claimed' : value === '0' || value === 0 ? 'not_claimed' : 'unknown';
}

export function cloneCommand(service: CreationRuntime, ...args: string[]): string[] {
  const { endpoint, locale } = service.client.config;
  return ['superun-ai', '--endpoint', endpoint, '--locale', locale, 'clone', ...args];
}

async function listProject(service: CreationRuntime, sessionId: string) {
  let cursorSessionId: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = parseWire(
      projectsSchema,
      await service.client.call('/api/uxa-center/agent/AgentCommunity/queryMySiteCloneProjects', {
        pageSize: 50,
        ...(cursorSessionId ? { cursorSessionId } : {}),
      }),
    );
    const project = page.find((item) => item.sessionId === sessionId);
    if (project || page.length < 50) return project;
    cursorSessionId = page.at(-1)!.sessionId;
    if (seen.has(cursorSessionId)) throw new CliError('PROTOCOL_ERROR', '搬家项目分页游标未推进');
    seen.add(cursorSessionId);
  }
}

async function readHead(service: CreationRuntime, sessionId: string) {
  const head = parseWire(
    headSchema,
    await service.client.call('/web-api/conversation-v2/main-agent-head', { sessionId }),
  );
  if (head.sessionId !== sessionId) throw new CliError('PROTOCOL_ERROR', '项目主线不匹配');
  return head;
}

export async function cloneState(service: CreationRuntime, sessionId: string, suppliedView?: SessionView) {
  const [project, head, view] = await Promise.all([
    listProject(service, sessionId),
    readHead(service, sessionId),
    suppliedView ?? service.load(sessionId),
  ]);
  if (String(view.extra.siteClone) !== '1')
    throw new CliError('INVALID_ARGUMENT', '该项目不是网站搬家项目', { sessionId });

  const projectUrl = new URL(`/web/project/${encodeURIComponent(sessionId)}`, service.client.config.endpoint)
    .href;
  const startedAt = project?.createdAt;
  const round = currentRound(view);
  const message = roundMessage(view, round);
  const now = Date.now();
  const remainingMinutes =
    startedAt === undefined ? undefined : Math.max(0, Math.ceil((startedAt + 90 * 60_000 - now) / 60_000));
  const progress: SiteCloneProgress = {
    phase: 'HANDOFF',
    projectUrl,
    startedAt,
    status: project?.status,
    weeklyFreeDecision: siteCloneWeeklyDecision(view.extra.siteCloneFree),
  };
  const observation = { progress, view, head, idleCandidate: false };
  if (enabled(head.roundExtra.startDevelopment)) progress.phase = 'DEVELOPING';
  else if (enabled(head.roundExtra.hasSelectedStyle)) progress.phase = 'EDITING';
  if (progress.phase === 'EDITING' || progress.phase === 'DEVELOPING') return observation;
  if (remainingMinutes !== undefined) {
    progress.remainingMinutes = remainingMinutes;
    progress.estimate = {
      basis: 'display_estimate',
      totalMinutes: 90,
      remainingMinutes,
      overdue: remainingMinutes === 0,
    };
  }

  const branchAnchor = view.session.pendingBranch?.preReplyMessageId;
  const choices = branchAnchor
    ? latestStyleChoices(await service.choices(sessionId, branchAnchor, view))
    : [];
  progress.branchAnchor = branchAnchor;
  // 分支必须属于当前未决批次；投影缺失或滞后时也能根据当前分支交付。
  const readyChoices = choices.filter(
    (item) => item.status === 'success' && item.previewUrl && !item.selected,
  );
  const result = readyChoices.find((item) => item.index === 0) ?? readyChoices[0];
  const failed = choices.find((item) => item.index === 0 && item.status === 'failed');
  const status = project?.status;
  const automaticTool = pendingAutomaticTools(view).length > 0;
  const active =
    [0, 1, 10].includes(view.session.status) || choices.some((item) => item.status === 'running');
  if (result) {
    const preview = new URL(
      `/web/style_preview/${encodeURIComponent(sessionId)}`,
      service.client.config.endpoint,
    );
    preview.searchParams.set('style', String(result.index));
    preview.searchParams.set('mode', 'site-clone');
    Object.assign(progress, {
      phase: 'PREVIEW_READY',
      result,
      resultId: result.choiceId,
      previewUrl: preview.href,
    });
  } else if (
    failed ||
    view.session.status === -1 ||
    view.session.errorType ||
    round?.status === 'failed' ||
    (status === 7 && !active)
  ) {
    progress.phase = 'FAILED';
    progress.errorType = failed?.errorType ?? view.session.errorType ?? message?.sessionErrorType;
    progress.retryChoiceId = failed?.messageId ? failed.choiceId : undefined;
    progress.retryMessageId = branchAnchor ? undefined : retryableMainMessage(view);
  } else if (round?.status === 'interrupted' || (status === 9 && !active) || view.session.status === 2) {
    progress.phase = 'INTERRUPTED';
  } else if (automaticTool || view.session.status === 4 || (status === 3 && view.session.status !== 1)) {
    progress.phase = 'NEEDS_INPUT';
  } else if (view.session.status === 10 || status === 2) {
    progress.phase = 'QUEUED';
  } else if (branchAnchor || status === 4 || status === 5) {
    progress.phase = 'GENERATING';
  } else if (view.session.status === 1 || view.session.status === 0 || status === 1) {
    progress.phase = 'READING';
  } else if (
    view.session.status === 3 &&
    round?.status === 'completed' &&
    (status === 8 || status === undefined || status === 0)
  ) {
    if (
      collectInteractions(view).some(
        ({ interaction }) => interaction.kind === 'ASK_USER_TOOL' || interaction.kind === 'ASK_USER_MESSAGE',
      )
    )
      progress.phase = 'NEEDS_INPUT';
    else observation.idleCandidate = true;
  }
  if (['NEEDS_INPUT', 'FAILED', 'INTERRUPTED', 'PREVIEW_READY'].includes(progress.phase)) {
    delete progress.remainingMinutes;
    delete progress.estimate;
  }
  return observation;
}

export type CloneObservation = Awaited<ReturnType<typeof cloneState>>;

export async function cloneResult(
  service: CreationRuntime,
  observation: CloneObservation,
): Promise<CreationResult> {
  const { progress, view, head } = observation;
  const sessionId = view.session.sessionId;
  const { endpoint, locale } = service.client.config;
  const chat = ['superun-ai', '--endpoint', endpoint, '--locale', locale, 'chat'];
  const linkAction = (instruction: string): NextAction => ({
    action: 'VIEW_PROJECT',
    requiresUserInput: true,
    instruction,
    command: [],
    url: progress.projectUrl,
  });
  const round = currentRound(view);
  const base: CreationResult = {
    sessionId,
    state: 'RUNNING',
    messageId: head.headMessageId ?? undefined,
    replyMessageId: head.headReplyMessageId ?? undefined,
    ...projectText(round ? [round] : []),
    interactions: [],
    siteClone: progress,
  };
  const { phase, resultId } = progress;
  if (phase === 'EDITING' || phase === 'DEVELOPING') {
    if (
      head.headMessageId &&
      !view.pipeline.messages.some((message) => message.messageId === head.headMessageId)
    )
      return {
        ...base,
        nextActions: [
          {
            action: 'WAIT',
            requiresUserInput: false,
            instruction: '等待当前编辑或研发消息同步。',
            command: [...chat, 'wait', sessionId, '--message-id', head.headMessageId],
          },
        ],
      };
    const result = service.withGuidance(await service.inspect(view));
    const previewUrl = result.demo?.url ?? result.development?.previewUrl;
    return { ...result, siteClone: { ...progress, previewUrl } };
  }
  if (phase === 'PREVIEW_READY' && resultId) {
    return {
      ...base,
      state: 'COMPLETED',
      choices: progress.result ? [progress.result] : [],
      nextActions: [
        {
          action: 'EDIT_APPEARANCE',
          requiresUserInput: true,
          instruction: '继续修改 → 修改网站样式和内容',
          command: cloneCommand(service, 'continue', sessionId, '--target', 'demo', '--result-id', resultId),
        },
        {
          action: 'START_DEVELOPMENT',
          requiresUserInput: true,
          instruction: '继续修改 → 给网站开发真实功能',
          command: cloneCommand(
            service,
            'continue',
            sessionId,
            '--target',
            'development',
            '--result-id',
            resultId,
          ),
        },
      ],
    };
  }
  if (phase === 'NEEDS_INPUT') {
    const result = service.withGuidance(await service.inspect(view));
    const interactions = result.interactions.filter((item) => item.kind !== 'UNSUPPORTED');
    return {
      ...result,
      state: 'NEEDS_INPUT',
      siteClone: progress,
      nextActions: interactions.length
        ? result.nextActions
        : [linkAction('网站搬家目前需要协助，请按本轮说明补充信息或打开项目处理。')],
    };
  }
  if (phase === 'FAILED' || phase === 'INTERRUPTED') {
    const { retryChoiceId, retryMessageId } = progress;
    return {
      ...base,
      state: phase,
      nextActions: [
        rechargeAction(progress.errorType, chat, sessionId, retryMessageId, retryChoiceId) ??
          (retryChoiceId
            ? {
                action: 'RETRY_STYLE',
                requiresUserInput: true,
                instruction: '核对失败原因后，可重试原搬家生成任务。',
                command: [...chat, 'style', 'retry', sessionId, retryChoiceId, '--no-wait'],
              }
            : retryMessageId
              ? {
                  action: 'RETRY',
                  requiresUserInput: true,
                  instruction: '核对失败原因后，可重试原搬家任务。',
                  command: [...chat, 'retry', sessionId, retryMessageId, '--no-wait'],
                }
              : linkAction('打开项目查看异常或中断详情。')),
      ],
    };
  }
  return {
    ...base,
    state: phase === 'QUEUED' ? 'QUEUED' : 'RUNNING',
    nextActions: [
      {
        action: 'WAIT',
        requiresUserInput: false,
        instruction: '继续等待原网站搬家项目。',
        command: cloneCommand(service, 'wait', sessionId),
      },
    ],
  };
}

export async function continueClone(
  service: CreationRuntime,
  sessionId: string,
  target: 'demo' | 'development',
  resultId?: string,
) {
  const current = await cloneState(service, sessionId);
  const { phase, result } = current.progress;
  if (phase === 'DEVELOPING' || (phase === 'EDITING' && target === 'demo')) {
    return { sessionId, alreadyContinued: true };
  }
  if (phase !== 'PREVIEW_READY' && phase !== 'EDITING')
    throw new CliError('STALE_INTERACTION', '当前搬家结果尚不可继续，请读取最新状态', { sessionId });
  if (resultId && (!result || result.choiceId !== resultId))
    throw new CliError('STALE_INTERACTION', '搬家结果已经变化，请查看最新预览', { sessionId });
  if (phase === 'EDITING') {
    const edited = await service.inspect(current.view);
    if (edited.state !== 'COMPLETED' || !edited.demo?.url)
      throw new CliError('STALE_INTERACTION', '请等待当前样式修改及预览完成后再进入研发', { sessionId });
    await service.previewVersions.prepareDevelopment(sessionId);
  }
  const latestHead = await readHead(service, sessionId);
  if (
    latestHead.headMessageId !== current.head.headMessageId ||
    latestHead.headReplyMessageId !== current.head.headReplyMessageId
  )
    throw new CliError('STALE_INTERACTION', '操作期间项目主线已变化，请读取当前结果', { sessionId });
  const development = target === 'development';
  const businessType = development ? 'start_dev' : 'choose_style_v2';
  const now = String(Date.now());
  try {
    const response = await service.command.chat({
      sessionId,
      previewVersionId: 0,
      minDuration: 0,
      content: development ? '给网站开发真实功能' : '修改网站样式和内容',
      businessParams: { business_type: businessType },
      ...(result
        ? {
            parallelSelectRequest: {
              sessionId,
              selectedReplyMessageId: result.replyMessageId,
              selectedLastReplyMessageId: result.lastReplyMessageId ?? result.replyMessageId,
            },
          }
        : {}),
      excludedInheritedRoundExtraKeys: ['cliPlanAfterStyle'],
      // 项目字段与本轮消息同一次 glowChat 写入，由 Center 同一事务提交。
      sessionExtra: {
        hasSelectedStyle: '1',
        ...(development
          ? { startDevelopment: '1', hasViewedBuild: '1' }
          : { hasGeneratedIdea: now, demoReadyAt: now }),
      },
      roundExtra: {
        business_type: businessType,
        hasSelectedStyle: '1',
        ROUND_LANGUAGE: service.client.config.locale,
        ...(development
          ? { startDevelopment: '1', showDismissInBuildTutorial: '0' }
          : { hasGeneratedIdea: now, demoReadyAt: now }),
      },
    });
    if (text(response.messageId) || text(response.replyMessageId)) {
      return response;
    }
    throw new CliError('OUTCOME_UNKNOWN', '阶段切换缺少写入回执', { sessionId });
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'OUTCOME_UNKNOWN') throw error;
    // 结果未知时只验证新主线，永远不重复提交阶段切换。
    const head = await readHead(service, sessionId).catch(() => undefined);
    if (
      head?.headMessageId &&
      head.headMessageId !== current.head.headMessageId &&
      head.roundExtra.business_type === businessType &&
      (development ? enabled(head.roundExtra.startDevelopment) : enabled(head.roundExtra.hasSelectedStyle))
    ) {
      return {
        sessionId,
        messageId: head.headMessageId,
        replyMessageId: head.headReplyMessageId,
        recovered: true,
      };
    }
    throw error;
  }
}
