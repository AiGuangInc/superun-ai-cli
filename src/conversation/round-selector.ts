/** 主链当前轮与消息锚点。@author xiuyu.yi */
import type { NodeRound, NodeMessage, SessionView } from '../contracts/node-wire.js';

export function currentRound(view: SessionView, messageId?: string): NodeRound | undefined {
  const rounds = view.pipeline.render?.rounds ?? [];
  if (messageId) {
    const found = rounds.find(
      (round) =>
        round.anchorUserMessageId === messageId ||
        [...round.agentItems, ...round.userItems].some((item) => item.source?.messageId === messageId),
    );
    if (found) return found;
  }
  return rounds
    .filter((round) => !round.meta?.consult && !round.meta?.passive && !round.meta?.subAgentReport)
    .sort((a, b) => a.time.timestamp - b.time.timestamp)
    .at(-1);
}

export function roundMessage(view: SessionView, round?: NodeRound): NodeMessage | undefined {
  if (!round) return undefined;
  return view.pipeline.messages
    .filter(
      (message) =>
        message.role === 2 &&
        (message.replyMessageId === round.anchorUserMessageId ||
          round.agentItems.some((item) => item.source?.messageId === message.messageId)),
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(-1);
}
