/** 交互与异步任务优先于单条消息终态。@author xiuyu.yi */
import type { SessionView } from '../contracts/node-wire.js';
import type { Choice, CreationResult } from '../contracts/cli-output.js';
import type { InteractionBinding } from '../interactions/context.js';
import { currentRound, roundMessage } from './round-selector.js';
import { projectText } from './text-projector.js';
import { pendingAutomaticTools, hasServerAutomaticWork } from '../auto-tools/registry.js';
import { CliError } from '../output/exit-codes.js';
import { enabled } from '../contracts/value.js';
import {
  isStyleSelected,
  latestStyleChoices,
  styleBatchState,
} from '../interactions/parsers/style-selection.js';
import type { StyleWaitTarget } from '../interactions/parsers/style-selection.js';

/** 统一判断自动任务是否仍在进行，避免未选功能打断当前创作。 */
export function hasPendingCreationWork(view: SessionView): boolean {
  if (view.automaticWork || pendingAutomaticTools(view).length || hasServerAutomaticWork(view)) return true;
  const round = currentRound(view),
    message = roundMessage(view, round);
  // 回执窗口可能没有工作卡，仍需核对已选功能的完成状态。
  return (
    view.session.status === 3 &&
    round?.status === 'completed' &&
    enabled(message?.roundExtra?.startDevelopment) &&
    view.features?.some(
      (feature) =>
        enabled(feature.checked) &&
        typeof feature.status === 'string' &&
        !['completed', 'cancelled', 'skipped'].includes(feature.status),
    ) === true
  );
}

export function resolveState(
  view: SessionView,
  bindings: Array<InteractionBinding>,
  choices: Array<Choice> = [],
  styleTarget?: StyleWaitTarget,
): CreationResult {
  const round = currentRound(view),
    message = roundMessage(view, round);
  const waitingForStyles = !!styleTarget || (!!view.session.pendingBranch && !isStyleSelected(view, choices));
  const currentChoices = styleTarget
    ? choices.filter((choice) => styleTarget.choiceIds.includes(choice.choiceId))
    : latestStyleChoices(choices);
  if (!view.pipeline.render && view.pipeline.messages.length)
    throw new CliError('PROTOCOL_ERROR', 'API 未返回会话轮次模型');
  const result: CreationResult = {
    state: 'RUNNING',
    sessionId: view.session.sessionId,
    topic: view.session.topic,
    messageId: message?.messageId,
    replyMessageId: round?.anchorUserMessageId,
    ...projectText(round ? [round] : []),
    interactions: bindings.map((binding) => binding.interaction),
    ...(waitingForStyles || currentChoices.length ? { choices: currentChoices } : {}),
    cursor: {
      messageId: message?.messageId,
      branchAnchor: waitingForStyles
        ? (styleTarget?.preReplyMessageId ?? view.session.pendingBranch?.preReplyMessageId)
        : undefined,
    },
  };
  if (view.session.status === -1 || view.session.errorType || round?.status === 'failed') {
    throw new CliError('BUSINESS_ERROR', '创作任务执行失败', {
      sessionId: result.sessionId,
      messageId: result.messageId,
      errorType: view.session.errorType,
      ...(result.interactions.length ? { interactions: result.interactions } : {}),
    });
  }
  if (bindings.length) {
    result.state = bindings.some((binding) => binding.interaction.kind === 'STYLE_SELECTION')
      ? 'NEEDS_SELECTION'
      : 'NEEDS_INPUT';
    return result;
  }
  if (waitingForStyles) {
    if (styleTarget && currentChoices.length !== styleTarget.choiceIds.length) return result;
    const state = styleBatchState(currentChoices);
    if (state === 'FAILED')
      throw new CliError('BUSINESS_ERROR', '本批风格均生成失败，可以使用 chat style retry 重试', {
        sessionId: result.sessionId,
        choices: currentChoices,
      });
    result.state = state;
    return result;
  }
  if (hasPendingCreationWork(view)) return result;
  if (view.session.status === 4)
    throw new CliError('UNSUPPORTED_INTERACTION', '会话正在等待当前 CLI 未识别的交互', {
      sessionId: result.sessionId,
      messageId: result.messageId,
    });
  if (view.session.status === 10) result.state = 'QUEUED';
  else if (view.session.status === 2) result.state = 'PAUSED';
  else if (round?.status === 'interrupted') result.state = 'INTERRUPTED';
  else if (view.session.status === 3 && round?.status === 'completed') {
    // 交接轮结束后还有后续任务，必须继续查询会话状态。
    if (message?.roundExtra?.business_type !== 'stage0_handoff_generate') result.state = 'COMPLETED';
  }
  return result;
}
