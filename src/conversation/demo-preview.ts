/** 从当前创作轮次对应的快照提取演示地址。@author xiuyu.yi */
import { z } from 'zod';
import type { Choice, DemoPreview } from '../contracts/cli-output.js';
import { parseWire } from '../contracts/node-wire.js';
import type { SessionView } from '../contracts/node-wire.js';
import type { AgentQueryApi } from '../api/agent-query-api.js';
import { enabled, list, text, object } from '../contracts/value.js';
import { currentRound, roundMessage } from './round-selector.js';
import { findDevelopmentSnapshot } from './development-snapshot.js';

const snapshotSchema = z.array(
  z.object({
    encryptedId: z.string().min(1),
    messageId: z.string().min(1),
    visitUrl: z.string().url().nullish(),
    createdAt: z.number(),
  }),
);

export function isInitialDemoRound(view: SessionView): boolean {
  const message = roundMessage(view, currentRound(view));
  return ['choose_style_v2', 'fake_confirm_generate_more_demo'].includes(
    String(message?.roundExtra?.business_type),
  );
}

export function demoGenerationStatus(view: SessionView): number {
  const message = roundMessage(view, currentRound(view));
  // Node 把演示进度放在当前消息内容中；Session extra 可能尚未由网页回写。
  // 当前轮的生成中标记优先于旧的 Session 完成标记，避免新演示被提前放行。
  const statuses = (message?.displayContents ?? [])
    .map((content) => Number(object(content.extra).demoGenerateStatus))
    .filter((status) => status === 1 || status === 2);
  return statuses.length ? Math.max(...statuses) : Number(view.extra.demoGenerateStatus);
}

export function projectDemoPreview(
  response: unknown,
  view: SessionView,
  choices: Array<Choice>,
): DemoPreview | undefined {
  const round = currentRound(view);
  const selected = choices.find((choice) => choice.selected);
  const messageIds = [round?.anchorUserMessageId, selected?.lastReplyMessageId, selected?.replyMessageId];
  const snapshots = parseWire(snapshotSchema, response).sort((a, b) => b.createdAt - a.createdAt);
  for (const messageId of messageIds) {
    if (!messageId) continue;
    const snapshot = snapshots.find((item) => item.messageId === messageId);
    if (!snapshot) continue;
    if (!snapshot.visitUrl) return undefined;
    const url = new URL(snapshot.visitUrl);
    if (url.protocol !== 'https:' || url.username || url.password) continue;
    return {
      snapshotId: snapshot.encryptedId,
      messageId: snapshot.messageId,
      url: snapshot.visitUrl,
      viewed: enabled(view.extra.hasViewedDemo),
    };
  }
  return undefined;
}

/** 修改演示可能由本轮收尾回执生成快照，只匹配本轮所属消息。 */
export async function findModifiedDemoPreview(
  query: AgentQueryApi,
  view: SessionView,
): Promise<DemoPreview | undefined> {
  const round = currentRound(view);
  if (!round) return undefined;
  const messageIds = [
    round.anchorUserMessageId,
    ...list(round.meta?.sourceMessageIds).map(text),
    ...round.agentItems.map((item) => item.source?.messageId),
  ].filter((id): id is string => !!id);
  const snapshot = await findDevelopmentSnapshot(query, view.session.sessionId, messageIds);
  if (!snapshot) return undefined;
  return {
    snapshotId: snapshot.snapshotId,
    messageId: snapshot.messageId,
    url: snapshot.url,
    viewed: enabled(view.extra.hasViewedDemo),
  };
}
