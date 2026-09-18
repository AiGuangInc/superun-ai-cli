/** 将本次安全扫描投影为会话进度与报告，不另行触发修复。@author xiuyu.yi */
import { createHash } from 'node:crypto';
import type { CreationResult, TaskProgressStatus, NextAction } from '../contracts/cli-output.js';
import type { SessionView, NodeRound } from '../contracts/node-wire.js';
import { text } from '../contracts/value.js';
import { currentRound, roundMessage } from './round-selector.js';
import { collectInteractions } from '../interactions/registry.js';
import { projectText } from './text-projector.js';
import { SecurityStage, SecurityStatus } from '../contracts/security-review.js';
import { securityActive } from '../api/security-review-api.js';
import type { SecurityReviewApi } from '../api/security-review-api.js';
import type { SecurityReviewView } from '../contracts/security-review.js';
import { CliError } from '../output/exit-codes.js';

const STATUS_LABELS = ['已跳过', '等待中', '进行中', '已完成', '失败', '已取消'];
const statusLabel = (status: number) => STATUS_LABELS[status] ?? '状态待同步';
const STAGE_LABELS = [
  '正在准备安全检查',
  '安全检查进行中',
  '安全评估进行中',
  '安全修复进行中',
  '审计报告生成中',
  '安全扫描已完成',
  '安全扫描未完成',
  '安全扫描已取消',
  '本次扫描已失效',
];

/** 只从当前轮认领扫描；不把历史扫描或继承到普通研发轮的标记当成当前任务。 */
export function roundSecurityReviewId(view: SessionView, round = currentRound(view)): string | undefined {
  if (!round) return undefined;
  const card = round.agentItems.find((item) => item.variant === 'security_scan');
  if (card) return text(card.payload.reviewId);
  // BFF 会把后台回执并入修复轮，末条 Agent 消息可能已变成 sub_agent_report。
  const anchor = view.pipeline.messages.find((message) => message.messageId === round.anchorUserMessageId);
  const extra = anchor?.roundExtra ?? roundMessage(view, round)?.roundExtra ?? {};
  if (extra.business_type === 'security_remediation') return text(extra.securityRemediationReviewId);
  const message = roundMessage(view, round);
  if (
    message?.roundExtra?.business_type === 'sub_agent_report' &&
    message.roundExtra.securityRemediationAgentMessageId === message.messageId
  )
    return text(message.roundExtra.securityRemediationReviewId);
  return undefined;
}

function ownedRound(view: SessionView, round: NodeRound, reviewId: string): boolean {
  return roundSecurityReviewId(view, round) === reviewId;
}

export function reportMarkdown(value?: string | null): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') return parsed.trim() || undefined;
  } catch {
    /* 报告已是 Markdown 时直接保留。 */
  }
  return value;
}

const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

export async function inspectSecurityReview(
  api: SecurityReviewApi,
  view: SessionView,
  requestedId?: string,
): Promise<CreationResult | undefined> {
  const reviewId = requestedId ?? roundSecurityReviewId(view);
  if (!reviewId) return undefined;
  let review = await api.query(view.session.sessionId, reviewId);
  if (!review.found)
    throw new CliError('INVALID_ARGUMENT', '未找到指定安全扫描，请核对扫描 ID', {
      sessionId: view.session.sessionId,
      reviewId,
    });
  if (!securityActive(review)) review = await api.query(view.session.sessionId, reviewId, true);
  if (!review.found)
    throw new CliError('PROTOCOL_ERROR', '本次安全扫描详情暂未同步，请继续查询', {
      sessionId: view.session.sessionId,
      reviewId,
    });
  return projectSecurityReview(view, review);
}

export function projectSecurityReview(view: SessionView, review: SecurityReviewView): CreationResult {
  const reviewId = review.reviewId!;
  const stage = review.stage;
  const body = reportMarkdown(review.reportResult);
  const ready =
    stage === SecurityStage.COMPLETED &&
    review.reportStatus === SecurityStatus.SUCCEEDED &&
    !!body &&
    Array.isArray(review.checks);
  let state: CreationResult['state'] = ready
    ? 'COMPLETED'
    : stage === SecurityStage.CANCELLED
      ? 'CANCELLED'
      : stage === SecurityStage.FAILED || stage === SecurityStage.INVALIDATED
        ? 'FAILED'
        : 'RUNNING';
  const owned = (view.pipeline.render?.rounds ?? []).filter((round) => ownedRound(view, round, reviewId));
  // 普通功能推荐不是扫描需要用户回答的问题。真实修复交互仍沿用原协议。
  const bindings = securityActive(review)
    ? collectInteractions(view).filter(
        (binding) =>
          owned.some((round) => round.roundId === binding.round.roundId) &&
          binding.interaction.kind !== 'SELECT_FEATURES',
      )
    : [];
  if (bindings.length) state = 'NEEDS_INPUT';
  const current = owned.at(-1);
  let notice = STAGE_LABELS[stage ?? 0] ?? '扫描状态待同步';
  if (stage === SecurityStage.COMPLETED && !ready) notice = '审计报告正在同步，请继续等待';
  if (stage === SecurityStage.INVALIDATED) notice = '安全修复未完成，本次扫描结果已失效，请重新扫描';
  if (stage === SecurityStage.FAILED && review.reportStatus === SecurityStatus.FAILED)
    notice = '审计报告生成失败，可重试生成报告，无需重新扫描或修复';
  if (review.reportStatus === SecurityStatus.SKIPPED && !securityActive(review))
    notice += '；本次未生成审计报告';
  const rows: [string, string][] = (review.checks ?? []).map((check) => [
    check.label || check.category,
    check.statusDesc || statusLabel(check.status),
  ]);
  rows.push(
    ['安全评估', review.assessmentStatus == null ? '等待中' : statusLabel(review.assessmentStatus)],
    [
      '安全修复',
      review.remediationStatus === SecurityStatus.SKIPPED
        ? '无需修复'
        : review.remediationStatus == null
          ? '等待中'
          : statusLabel(review.remediationStatus),
    ],
    [
      '审计报告',
      review.reportStatus == null ? '等待中' : review.reportStatusDesc || statusLabel(review.reportStatus),
    ],
  );
  const markdown = [
    `**本次安全扫描${review.reviewSeqNo === undefined ? '' : `（第 ${review.reviewSeqNo} 次）`}**`,
    '',
    notice,
    '',
    '| 检查项 | 状态 |',
    '| --- | --- |',
    ...rows.map(([name, label]) => `| ${cell(name)} | ${cell(label)} |`),
  ].join('\n');
  const id = `security:${reviewId}`;
  const taskStatus: TaskProgressStatus =
    state === 'COMPLETED'
      ? 'completed'
      : state === 'FAILED'
        ? 'failed'
        : state === 'CANCELLED'
          ? 'interrupted'
          : state === 'NEEDS_INPUT'
            ? 'needs_input'
            : 'running';
  const messages: CreationResult['messages'] = ready
    ? [
        {
          id: `${id}:report`,
          role: 'assistant',
          text: '本次安全扫描已完成。',
        },
      ]
    : bindings.length
      ? projectText(owned).messages.filter((message) => message.role === 'assistant')
      : state === 'FAILED' || state === 'CANCELLED'
        ? [{ id: `${id}:result`, role: 'assistant', text: notice }]
        : [];
  const { found: _found, ...details } = review;
  return {
    state,
    sessionId: view.session.sessionId,
    topic: view.session.topic,
    messageId: roundMessage(view, current)?.messageId,
    replyMessageId: current?.anchorUserMessageId,
    messages,
    progress: [],
    interactions: bindings.map((binding) => binding.interaction),
    securityReview: { ...details, reviewId, reportResult: ready ? body : undefined },
    taskProgress: {
      id,
      revision: createHash('sha256').update(markdown).digest('hex').slice(0, 16),
      activeCount: state === 'RUNNING' || state === 'NEEDS_INPUT' ? 1 : 0,
      tasks: [{ id, kind: 'security', title: '安全扫描', status: taskStatus, detail: notice }],
      markdown,
      complete: Array.isArray(review.checks),
      warnings: [],
    },
  };
}

export const SECURITY_REVIEW_INSTRUCTION =
  '运行中只展示本次安全扫描的 taskProgress.markdown，按同一 id 更新列表；不展示历史扫描、不估算百分比、不把检查完成解释为无风险。评估和必要修复由服务端自动执行，只展示阶段状态，不重复发送修复指令、不增加确认、不展开内部派发消息。完成后依据 securityReview.reportResult 展示简洁结果摘要：实际发现的问题及风险、已处理内容、未处理事项和必要的未覆盖范围，数量与结论必须有报告依据。不展开完整报告正文、不提供完整报告或 PDF 下载链接、不另行生成报告文件。宿主支持直接内嵌展示 PDF 时可展示原 PDF，否则只展示结果摘要。正常完成后必须在摘要后接上“接下来，你可以：”，展示 nextActions 中符合条件的继续创作、自动测试、上线运营三项引导，不能省略；若存在当前必须处理的阻碍，先说明具体事项并引导处理。真实业务提问、执行错误和余额不足仍须如实展示。';

export function securityNextActions(
  result: Pick<CreationResult, 'sessionId' | 'state'> & Partial<CreationResult>,
  command: string[],
): NextAction[] | undefined {
  const review = result.securityReview;
  if (!review || result.interactions?.length) return undefined;
  const target = ['--review-id', review.reviewId, '--', result.sessionId];
  if (['ACCEPTED', 'RUNNING', 'QUEUED'].includes(result.state))
    return [
      {
        action: 'WAIT_SECURITY_SCAN',
        requiresUserInput: false,
        instruction: '持续跟进本次扫描直到报告生成，不把扫描消息结束或修复任务启动当作完成，不展示后置菜单。',
        command: [
          ...command,
          'wait',
          ...(result.taskProgress?.revision ? ['--progress-revision', result.taskProgress.revision] : []),
          ...target,
        ],
      },
      {
        action: 'CANCEL_SECURITY_SCAN',
        when: '仅在用户主动要求停止本次扫描或自动修复时执行；不作为等待期间的操作菜单展示。',
        requiresUserInput: true,
        instruction: '用户明确要求停止后，取消本次扫描及自动修复，不调用普通会话停止命令。',
        command: [...command, 'stop', ...target],
      },
    ];
  if (result.state !== 'COMPLETED')
    return [
      {
        action:
          review.stage === SecurityStage.FAILED && review.reportStatus === SecurityStatus.FAILED
            ? 'RETRY_SECURITY_REPORT'
            : 'RESTART_SECURITY_SCAN',
        requiresUserInput: true,
        instruction:
          review.stage === SecurityStage.FAILED && review.reportStatus === SecurityStatus.FAILED
            ? '说明报告生成失败。用户要求重试时只重试报告，不重新扫描或修复。'
            : '如实说明扫描失败、取消或失效的状态与原因。用户要求重新扫描后再执行，不自动重启。',
        command:
          review.stage === SecurityStage.FAILED && review.reportStatus === SecurityStatus.FAILED
            ? [...command, 'security', '--retry-report', review.reviewId, '--', result.sessionId]
            : [...command, 'security', '--', result.sessionId],
      },
    ];
  const when =
    '扫描及报告已完成，且没有当前必须优先处理的遗留问题或阻碍时展示。仅有未来接入真实数据等条件下才需要处理的注意事项时，先说明该事项，再照常展示完成后的三项引导，不省略菜单，也不宣称无风险。';
  return [
    {
      action: 'CONTINUE_CHAT',
      when,
      requiresUserInput: true,
      instruction: '展示“- **继续创作**：告诉我想新增或调整的内容。”，收到需求后原样提交 content。',
      command: [...command, 'send', '--input', '-', '--', result.sessionId],
    },
    {
      action: 'AUTO_TEST',
      when,
      requiresUserInput: true,
      instruction: '展示“- **自动测试**：验证相关功能或修复效果。”，用户选择后按实际范围执行。',
      command: [...command, 'test', '--', result.sessionId],
    },
    {
      action: 'REVIEW_PUBLISH',
      when,
      requiresUserInput: true,
      instruction: '展示“- **上线运营**：将成果发布为正式版本。”，只有用户明确要求上线才按现有发布流程执行。',
      command: [...command, 'publish', 'status', '--for-launch', '--', result.sessionId],
    },
  ];
}
