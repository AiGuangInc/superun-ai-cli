/** 从当前创作轮次对应的快照提取演示地址。@author xiuyu.yi */
import { z } from 'zod';
import type { Choice, DemoPreview } from '../contracts/cli-output.js';
import { parseWire } from '../contracts/node-wire.js';
import type { SessionView } from '../contracts/node-wire.js';
import { enabled } from '../contracts/value.js';
import { currentRound, roundMessage } from './round-selector.js';

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
