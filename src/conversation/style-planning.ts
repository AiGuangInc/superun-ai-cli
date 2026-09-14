/** 网页与 CLI 交替操作时，沿真实父消息恢复本次风格选择的静默流程。@author xiuyu.yi */
import type { AgentQueryApi } from '../api/agent-query-api.js';
import type { SessionView } from '../contracts/node-wire.js';
import { enabled, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { currentRound, roundMessage } from './round-selector.js';

function canContinue(extra: Record<string, unknown>): boolean {
  if (!enabled(extra.hasSelectedStyle) || enabled(extra.architecturePlanApproved)) return false;
  const type = text(extra.business_type);
  return (
    type === 'choose_style_v2' ||
    type === 'fake_confirm_generate_more_demo' ||
    (enabled(extra.startDevelopment) && (!type || type === 'start_dev' || type === 'casual_chat'))
  );
}

export async function stylePlanningChoice(
  view: SessionView,
  query: Pick<AgentQueryApi, 'messageContext'>,
): Promise<string | undefined> {
  const current = currentRound(view);
  if (!current) return undefined;
  const extra = roundMessage(view, current)?.roundExtra ?? {};
  if (!canContinue(extra)) return undefined;
  const direct = text(extra.cliPlanAfterStyle);
  if (direct) return direct;

  const visited = new Set<string>();
  let messageId: string | undefined = current.anchorUserMessageId;
  // Glow 的假消息不会携带 CLI 专用字段；不能要求它自动继承，也不能取最近任意风格轮。
  while (messageId && visited.size < 32) {
    if (visited.has(messageId)) throw new CliError('PROTOCOL_ERROR', '风格衔接的消息链存在循环，无法继续');
    visited.add(messageId);
    const source = await query.messageContext(view.session.sessionId, messageId);
    if (!canContinue(source.roundExtra)) return undefined;
    const choiceId = text(source.roundExtra.cliPlanAfterStyle);
    if (choiceId) return choiceId;
    // 新的网页风格选择或后续独立规划不能借用更早的 CLI 自动衔接授权。
    if (source.roundExtra.business_type === 'choose_style_v2') return undefined;
    messageId = text(source.preMessageId);
  }
  if (messageId) throw new CliError('PROTOCOL_ERROR', '风格衔接的消息链过长，无法确认当前步骤');
  return undefined;
}
