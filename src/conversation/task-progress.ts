/** 按 Glow 的消息和任务身份生成多任务进度卡。@author xiuyu.yi */
import { createHash } from 'node:crypto';
import type {
  Choice,
  Interaction,
  TaskProgressItem,
  TaskProgressSnapshot,
  TaskProgressStatus,
} from '../contracts/cli-output.js';
import type { NodeRound, SessionView } from '../contracts/node-wire.js';
import { enabled, list, object, text } from '../contracts/value.js';
import { currentRound, roundMessage } from './round-selector.js';
import { latestStyleChoices, styleChoiceLabel } from '../interactions/parsers/style-selection.js';
import { visibleText } from './text-projector.js';

const ACTIVE = new Set<TaskProgressStatus>(['submitted', 'queued', 'running', 'waiting', 'needs_input']);
const LABELS: Record<TaskProgressStatus, string> = {
  submitted: '📨 已提交',
  queued: '⏳ 排队中',
  running: '🔄 进行中',
  waiting: '⏳ 等待中',
  needs_input: '✋ 等待确认',
  completed: '✅ 已完成',
  failed: '❌ 失败',
  interrupted: '⏸ 已中断',
  unknown: '❔ 状态待同步',
};

export function activeTask(status: TaskProgressStatus): boolean {
  return ACTIVE.has(status);
}

export function ownerId(value: unknown): string | undefined {
  const id = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? id : undefined;
}

export function roundOwner(view: SessionView, round: NodeRound): string | undefined {
  const anchor = view.pipeline.messages.find((message) => message.messageId === round.anchorUserMessageId);
  return ownerId(object(round.owner).userId ?? anchor?.extra?.operatorUserId ?? anchor?.userId);
}

export function messageTaskStatus(status: unknown): TaskProgressStatus {
  switch (status) {
    case 0:
      return 'running';
    case 10:
      return 'queued';
    case 4:
      return 'waiting';
    case 1:
      return 'completed';
    case -1:
      return 'failed';
    default:
      return 'unknown';
  }
}

export function workBlockStatus(status: unknown): TaskProgressStatus {
  return ['running', 'completed', 'failed', 'interrupted'].includes(String(status))
    ? (status as TaskProgressStatus)
    : 'unknown';
}

function strings(value: unknown): Array<string> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return list(value).filter((item): item is string => typeof item === 'string' && !!item.trim());
}

/** 叙述优先；冷启动状态只取当前提示，不把轮播候选当成已执行的阶段。 */
export function roundProgressDetail(
  view: SessionView,
  round: NodeRound,
): Pick<TaskProgressItem, 'detail' | 'activity'> {
  const message = roundMessage(view, round);
  const extra = message?.roundExtra ?? {};
  const hasContent = round.agentItems.some(
    (item) => item.kind === 'bubble' || (item.kind === 'card' && item.variant !== 'work_block'),
  );
  const detail =
    strings(extra.narration_messages).at(-1) ??
    (!hasContent ? (text(extra.status_message) ?? strings(extra.status_messages)[0]) : undefined);
  const summary = object(round.activity?.summary);
  const activity = Object.fromEntries(
    ['readCount', 'editCount', 'deployCount', 'toolCount']
      .filter(
        (key) =>
          typeof summary[key] === 'number' && Number.isSafeInteger(summary[key]) && Number(summary[key]) >= 0,
      )
      .map((key) => [key, summary[key]]),
  );
  return { ...(detail ? { detail } : {}), ...(Object.keys(activity).length ? { activity } : {}) };
}

export function projectMessageTasks(
  view: SessionView,
  interactions: Array<Interaction> = [],
): Array<TaskProgressItem> {
  const current = currentRound(view);
  const currentUser = ownerId(view.pipeline.render?.currentUserId);
  const tasks: Array<TaskProgressItem> = [];
  const seenMessages = new Set<string>();
  for (const round of view.pipeline.render?.rounds ?? []) {
    if (round.meta?.passive) continue;
    const message = roundMessage(view, round);
    const isCurrent = round.roundId === current?.roundId;
    if (!message && round.status !== 'running' && !isCurrent) continue;
    if (message && seenMessages.has(message.messageId)) continue;
    let status = messageTaskStatus(message?.status);
    if (round.status === 'failed') status = 'failed';
    else if (interactions.some((item) => item.source.roundId === round.roundId)) status = 'needs_input';
    else if (round.status === 'interrupted') status = 'waiting';
    else if (status === 'unknown') status = round.status === 'running' ? 'running' : 'submitted';
    if (!isCurrent && !activeTask(status)) continue;
    // style_card 已有独立候选进度，不把其 main round 再计成一个生成任务。
    if (round.agentItems.some((item) => item.variant === 'style_card')) continue;
    const own = currentUser !== undefined && roundOwner(view, round) === currentUser;
    if (!own && !activeTask(status)) continue;
    const title = round.userItems
      .map((item) => visibleText(item.payload))
      .find(Boolean)
      ?.split('\n')[0]
      ?.trim();
    const preparingPlan =
      !!text(message?.roundExtra?.cliPlanAfterStyle) &&
      !enabled(message?.roundExtra?.startDevelopment) &&
      ['choose_style_v2', 'fake_confirm_generate_more_demo'].includes(
        String(message?.roundExtra?.business_type),
      );
    tasks.push({
      id: `round:${round.roundId}`,
      kind: !own ? 'other-member' : round.meta?.consult ? 'consult' : 'message',
      title: !own
        ? '其他成员或归属待确认的任务'
        : preparingPlan
          ? '生成研发规划'
          : title || (round.meta?.consult ? '咨询任务' : '当前任务'),
      status: preparingPlan && own ? 'waiting' : status,
      ...(own ? (preparingPlan ? { detail: '正在准备研发规划' } : roundProgressDetail(view, round)) : {}),
      messageId: message?.messageId,
      roundId: round.roundId,
    });
    if (message) seenMessages.add(message.messageId);
  }
  return tasks;
}

export function projectStyleTasks(choices: Array<Choice>): Array<TaskProgressItem> {
  const styles = latestStyleChoices(choices);
  if (styles.some((choice) => choice.selected)) return [];
  return [...styles]
    .sort((a, b) => a.index - b.index)
    .map((choice) => ({
      id: `style:${choice.choiceId}`,
      kind: 'style',
      title: `风格${styleChoiceLabel(choice)}`,
      status:
        choice.errorType || choice.status === 'failed'
          ? 'failed'
          : choice.status === 'success' && choice.screenshotUrl
            ? 'completed'
            : 'running',
      detail: choice.status === 'success' && !choice.screenshotUrl ? '正在准备截图' : undefined,
    }));
}

function safeCell(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]{}|]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function taskProgressSnapshot(
  sessionId: string,
  tasks: Array<TaskProgressItem>,
  warnings: Array<string> = [],
): TaskProgressSnapshot {
  const unique = [
    ...new Map(
      tasks.map(({ activity: _activity, ...task }) => [
        task.id,
        !activeTask(task.status) && task.status !== 'unknown' ? { ...task, detail: undefined } : task,
      ]),
    ).values(),
  ].sort((a, b) =>
    // 功能已按 Glow 的开发中优先规则排列，保留同状态功能的服务端顺序。
    a.kind === 'feature' && b.kind === 'feature' ? 0 : a.id.localeCompare(b.id),
  );
  const notices = [...new Set(warnings)].sort();
  const activeCount = unique.filter((task) => activeTask(task.status)).length;
  const visibleTask = ({
    id,
    kind,
    title,
    status,
    detail,
    featureId,
    steps,
    stepProgress,
  }: TaskProgressItem) => ({
    id,
    kind,
    title,
    status,
    detail,
    featureId,
    steps,
    stepProgress,
  });
  const revision = createHash('sha256')
    .update(JSON.stringify({ tasks: unique.map(visibleTask), warnings: notices }))
    .digest('hex');
  const rows = unique
    .filter((task) => task.kind !== 'feature')
    .map(
      (task) =>
        `| ${safeCell(task.title)} | ${LABELS[task.status]} | ${safeCell(task.detail ?? '') || '—'} |`,
    );
  const stepLabels = { pending: '⏳ 待开始', in_progress: '🔄 进行中', completed: '✅ 已完成' };
  const featureSections = unique
    .filter((task) => task.kind === 'feature')
    .map((task) => {
      const steps = task.steps ?? [];
      const progress = task.stepProgress;
      return [
        `**${safeCell(task.title)}** · ${LABELS[task.status]}${progress ? ` · 已完成 ${progress.completed}/${progress.total}` : ''}`,
        steps.length
          ? [
              '| 步骤 | 状态 |',
              '| --- | --- |',
              ...steps.map((step) => `| ${safeCell(step.content)} | ${stepLabels[step.status]} |`),
            ].join('\n')
          : task.status === 'waiting'
            ? ''
            : '步骤尚未生成。',
      ]
        .filter(Boolean)
        .join('\n\n');
    });
  const markdown = [
    `**任务进度 · ${activeCount} 项进行中**`,
    ...featureSections,
    rows.length
      ? ['| 任务 | 状态 | 当前进度 |', '| --- | --- | --- |', ...rows].join('\n')
      : featureSections.length
        ? ''
        : '暂无进行中的任务。',
    ...notices.map((notice) => `ℹ️ ${safeCell(notice)}`),
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    id: `tasks:${sessionId}`,
    revision,
    activeCount,
    tasks: unique,
    markdown,
    complete: !notices.length,
    warnings: notices,
  };
}

export function submittedTaskProgress(
  sessionId: string,
  id: string,
  title = '任务已提交',
): TaskProgressSnapshot {
  return taskProgressSnapshot(sessionId, [
    { id: `request:${id}`, kind: 'request', title, status: 'submitted' },
  ]);
}
