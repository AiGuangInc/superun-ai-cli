/** 按独立演示轮所属消息匹配快照。@author xiuyu.yi */
import { z } from 'zod';
import type { AgentQueryApi } from '../api/agent-query-api.js';
import type { DemoPreview } from '../contracts/cli-output.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';

const snapshotsSchema = z.array(
  z.object({
    encryptedId: z.string().min(1),
    messageId: z.string().min(1),
    createdAt: z.number(),
    visitUrl: z.string().nullish(),
  }),
);
const pageSchema = z.union([
  z.object({ data: snapshotsSchema, totalCount: z.number().int().nonnegative() }),
  // 公共响应信封已解包为列表时，仍按页长判断是否还有下一页。
  snapshotsSchema,
]);
type SnapshotRecord = z.infer<typeof snapshotsSchema>[number];
type ReadySnapshot = Pick<DemoPreview, 'snapshotId' | 'messageId' | 'url'>;

function readySnapshot(snapshot: SnapshotRecord): ReadySnapshot {
  let url: URL;
  try {
    url = new URL(snapshot.visitUrl ?? '');
  } catch {
    throw new CliError('PROTOCOL_ERROR', '研发快照地址无效');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new CliError('PROTOCOL_ERROR', '研发快照未提供安全的 HTTPS 地址');
  return {
    snapshotId: snapshot.encryptedId,
    messageId: snapshot.messageId,
    url: snapshot.visitUrl!,
  };
}

export async function findDevelopmentSnapshot(
  query: AgentQueryApi,
  sessionId: string,
  messageId: string | Array<string>,
): Promise<ReadySnapshot | undefined> {
  const messageIds = new Set(Array.isArray(messageId) ? messageId : [messageId]);
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    const response = parseWire(pageSchema, await query.developmentSnapshots(sessionId, page));
    const items = Array.isArray(response) ? response : response.data;
    const snapshot = items
      .filter((item) => messageIds.has(item.messageId))
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (snapshot) {
      if (snapshot.visitUrl) return readySnapshot(snapshot);
      return undefined;
    }
    if (!items.length || (Array.isArray(response) ? items.length < 50 : page * 50 >= response.totalCount))
      return undefined;
    if (items.every((item) => seen.has(item.encryptedId)))
      throw new CliError('PROTOCOL_ERROR', '研发快照分页未前进，请稍后重试查询');
    for (const item of items) seen.add(item.encryptedId);
  }
}
