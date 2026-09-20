/** Agent 友好的只读状态与公开接入参数，沿用 Glow 接口。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';
import { HttpClient } from '../transport/http-client.js';

export const AGENT_FRIENDLY_SKILL_ID = 'skill.superun_mcp.integrate';
export const LEGACY_AGENT_FRIENDLY_SKILL_ID = 'superun.superun-cli.integrate';
const PREFIX = '/api/uxa-center/agent/AgentQuery';
const URL_KEYS = ['VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_URL', 'SUPABASE_URL'];
const ANON_KEYS = [
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
];

/** 与 Glow 相同的变量优先级，只提取接入所需的公开配置，不返回整个 .env。 */
function readEnvValue(content: string, keys: string[]): string {
  for (const key of keys) {
    const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'));
    if (!match) continue;
    const value = match[1]!.trim();
    return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
      ? value.slice(1, -1)
      : value;
  }
  return '';
}

function publicKey(value: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    return JSON.parse(Buffer.from(value.split('.')[1]!, 'base64url').toString()).role === 'anon';
  } catch {
    return false;
  }
}

export class AgentFriendlyApi {
  constructor(
    private readonly client: ApiClient,
    private readonly http = new HttpClient(),
  ) {}

  async enabled(sessionId: string): Promise<boolean> {
    const result = parseWire(
      z.object({
        exists: z.boolean(),
        skills: z.record(z.object({ state: z.enum(['ENABLED', 'DISABLED']).optional() })).optional(),
      }),
      await this.client.call(`${PREFIX}/querySkillState`, { sessionId }),
    );
    if (result.exists && !result.skills)
      throw new CliError('PROTOCOL_ERROR', '技能状态响应不完整，请重新查询');
    return [AGENT_FRIENDLY_SKILL_ID, LEGACY_AGENT_FRIENDLY_SKILL_ID].some(
      (id) => result.skills?.[id]?.state === 'ENABLED',
    );
  }

  async connection(sessionId: string, appName: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId) || !appName.trim())
      throw new CliError('PROTOCOL_ERROR', '项目缺少有效的会话标识或 sessionKey，无法生成接入指令');
    const content = await this.client.call(`${PREFIX}/queryAttachment`, { sessionId, name: '.env' });
    const supabaseUrl = readEnvValue(typeof content === 'string' ? content : '', URL_KEYS);
    const anonKey = readEnvValue(typeof content === 'string' ? content : '', ANON_KEYS);
    // 指令会被复制到 Shell，仅接受 HTTPS 地址与公开 Key，不泄露误填的服务端凭据。
    if (!/^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/?$/.test(supabaseUrl) || !publicKey(anonKey))
      throw new CliError(
        'PROTOCOL_ERROR',
        '项目缺少有效的 Supabase 地址或公开访问 Key，无法交付可执行的接入指令',
        { sessionId },
      );
    const manifestUrl = `https://id--${sessionId}.superun.yun/superun/openapi.json`;
    const manifest = await this.http.request({
      url: manifestUrl,
      method: 'GET',
      timeoutMs: 15000,
      signal: this.client.signal,
    });
    const parsed = parseWire(
      z.object({ openapi: z.string().min(1), paths: z.record(z.unknown()) }),
      manifest.data,
    );
    if (!Object.keys(parsed.paths).length)
      throw new CliError('PROTOCOL_ERROR', '项目 OpenAPI 清单没有可用接口，请先更新项目接入能力', {
        sessionId,
      });
    return { appName, supabaseUrl, anonKey, manifestUrl };
  }
}
