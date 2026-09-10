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
  // 对齐 Glow 的末轮判定：按 BFF 展示顺序取最后一个非咨询、非被动轮，包含最终回执。
  return rounds.filter((round) => !round.meta?.consult && !round.meta?.passive).at(-1);
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
