import { z } from 'zod';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';
import type { ApiClient } from '../transport/api-client.js';

const projectMode = z.object({
  autoMode: z.union([z.literal('0'), z.literal('1'), z.literal(0), z.literal(1)]).optional(),
});

export function querySessionExtra(client: ApiClient, sessionId: string) {
  return client.call('/api/uxa-center/agent/AgentQuery/querySessionExtra', { sessionId });
}

export async function assertProjectWritable(client: ApiClient, sessionId: string): Promise<void> {
  // Center 在解锁和退出时把 autoMode 清零；从未托管的项目可以没有这个字段。
  const { autoMode } = parseWire(projectMode, await querySessionExtra(client, sessionId));
  if (autoMode === '1' || autoMode === 1)
    throw new CliError('BUSINESS_ERROR', '全托管期间 CLI 仅支持查询，请到项目详情页操作。', { sessionId });
}
