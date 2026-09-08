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
  const active = rounds
    .filter((round) => !round.meta?.consult && !round.meta?.passive)
    .sort((a, b) => a.time.timestamp - b.time.timestamp);
  // 最近窗口可能只剩主任务处理子任务回执的轮次；不能把真正的收尾轮全部过滤掉。
  return active.filter((round) => !round.meta?.subAgentReport).at(-1) ?? active.at(-1);
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
