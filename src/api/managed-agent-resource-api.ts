/** 托管智能体创建流程的角色检查与同项目资源读回。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';

const publicAgentId = /^uxagent_[A-Za-z0-9_-]{16,}$/;
const optionalText = z.string().nullish();
const timestamp = z.union([z.string(), z.number().int().safe()]).nullish();
const memberSchema = z.object({
  members: z.array(z.object({ itsYou: z.boolean().nullish(), role: optionalText, status: optionalText })),
});
const agentSchema = z.object({
  id: z.string().regex(publicAgentId),
  name: optionalText,
  description: optionalText,
  version: z.number().int().positive().safe().nullish(),
  model: z.union([z.string(), z.object({ id: z.string().min(1) })]).nullish(),
  created_at: timestamp,
  updated_at: timestamp,
});

function requireSessionId(sessionId: string): void {
  if (!sessionId || /[\s,\/\\?#]/.test(sessionId))
    throw new CliError('INVALID_ARGUMENT', '请明确本次操作的单个项目 sessionId');
}

/** 原生 provider ID 不经项目映射，不允许作为公开资源读取目标。 */
export function validateManagedAgentId(value: string): string {
  if (!publicAgentId.test(value))
    throw new CliError('INVALID_ARGUMENT', '请使用本次创建返回的公开 uxagent_ 智能体 ID');
  return value;
}

export class ManagedAgentResourceApi {
  constructor(private readonly client: ApiClient) {}

  async assertEditor(sessionId: string): Promise<'owner' | 'editor'> {
    requireSessionId(sessionId);
    const response = parseWire(
      memberSchema,
      await this.client.call('/web-api/conversation/session-member-info', { sessionId }),
    );
    const current = response.members.filter((member) => member.itsYou === true);
    if (current.length !== 1)
      throw new CliError('PROTOCOL_ERROR', '无法唯一确认当前账号的项目角色，未写入智能体资源', {
        sessionId,
      });
    const member = current[0]!;
    const role = member.role?.trim().toLowerCase();
    const status = member.status?.trim().toLowerCase();
    if ((role !== 'owner' && role !== 'editor') || (status != null && status !== 'active'))
      throw new CliError('AUTH_REQUIRED', '当前账号没有该项目的编辑权限，不能继续创建智能体', {
        sessionId,
      });
    return role;
  }

  async getAgent(sessionId: string, agentId: string) {
    requireSessionId(sessionId);
    validateManagedAgentId(agentId);
    const response = await this.client.request(
      `/web-api/managed-agent-v2/v1/agents/${encodeURIComponent(agentId)}`,
      undefined,
      { method: 'GET', sessionId, native: true },
    );
    // 逐层白名单剔除 system、MCP 配置、请求头及任意 provider 内部字段。
    const agent = parseWire(agentSchema, response.data);
    if (agent.id !== agentId)
      throw new CliError('PROTOCOL_ERROR', '智能体读回 ID 与本次查询目标不一致', { sessionId, agentId });
    return agent;
  }
}
