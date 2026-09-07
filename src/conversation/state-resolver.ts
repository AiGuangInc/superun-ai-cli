/** 交互与异步任务优先于单条消息终态。@author xiuyu.yi */
import type { SessionView } from '../contracts/node-wire.js';
import type { Choice, CreationResult } from '../contracts/cli-output.js';
import type { InteractionBinding } from '../interactions/context.js';
import { currentRound, roundMessage } from './round-selector.js';
import { projectText } from './text-projector.js';
import { pendingAutomaticTools, hasServerAutomaticWork } from '../auto-tools/registry.js';
import { CliError } from '../output/exit-codes.js';

export function resolveState(
  view: SessionView,
  bindings: Array<InteractionBinding>,
  choices: Array<Choice> = [],
): CreationResult {
  const round = currentRound(view),
    message = roundMessage(view, round);
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
    ...(view.session.pendingBranch ? { choices } : {}),
    cursor: { messageId: message?.messageId, branchAnchor: view.session.pendingBranch?.preReplyMessageId },
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
  if (view.session.pendingBranch) {
    if (choices.some((choice) => choice.status === 'success')) result.state = 'NEEDS_SELECTION';
    else if (choices.length && choices.every((choice) => choice.status === 'failed'))
      throw new CliError('BUSINESS_ERROR', '本批风格均生成失败，可以使用 chat style retry 重试', {
        sessionId: result.sessionId,
        choices,
      });
    return result;
  }
  if (view.automaticWork || pendingAutomaticTools(view).length || hasServerAutomaticWork(view)) return result;
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
