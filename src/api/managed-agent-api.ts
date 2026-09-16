/** Glow 同源托管智能体接口；不提供文件或技能包上传。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { object, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
export type ResourceOption = { id: string; label: string };
export type SkillOption = ResourceOption & { type: 'builtin' | 'custom'; description?: string };
export type WizardCatalog = { memories: ResourceOption[]; skills: SkillOption[]; warnings: string[] };
const base = '/web-api/managed-agent-v2';
const resourceList = z.object({
  items: z.array(
    z.object({ entityId: z.string(), data: z.record(z.unknown()), unavailable: z.boolean().optional() }),
  ),
});
export class ManagedAgentApi {
  constructor(private readonly client: ApiClient) {}
  private async get(sessionId: string, path: string) {
    return (
      await this.client.request(`${base}${path}`, undefined, { method: 'GET', sessionId, native: true })
    ).data;
  }
  async catalog(sessionId: string): Promise<WizardCatalog> {
    const results = await Promise.allSettled([
      this.get(sessionId, '/resource-bootstrap?family=memory_stores'),
      this.get(sessionId, '/resource-bootstrap?family=skills'),
      this.get(sessionId, '/v1/capabilities'),
    ]);
    const warnings: string[] = [];
    const resources = (index: number, family: string) => {
      const result = results[index];
      if (result?.status === 'fulfilled') {
        const parsed = resourceList.safeParse(object(result.value)[family]);
        if (parsed.success) return parsed.data.items.filter((item) => !item.unavailable && item.entityId);
      }
      warnings.push(
        family === 'memory_stores'
          ? '已有记忆库加载失败，可重试或选择新建/不使用。'
          : '自定义技能目录加载失败，可重试或跳过。',
      );
      return [];
    };
    const memories = resources(0, 'memory_stores').map((item) => ({
      id: item.entityId,
      label: text(item.data.name) || item.entityId,
    }));
    const custom: SkillOption[] = resources(1, 'skills').map((item) => ({
      id: item.entityId,
      label: text(item.data.display_title) || text(item.data.name) || item.entityId,
      type: 'custom',
      description: text(item.data.description),
    }));
    const result = results[2];
    const parsed = z
      .object({
        skills: z.object({
          type: z.string().optional(),
          data: z.array(
            z.object({
              skill_id: z.string(),
              display_title: z.string().optional(),
              description: z.string().optional(),
            }),
          ),
        }),
      })
      .safeParse(result.status === 'fulfilled' ? result.value : undefined);
    if (!parsed.success) warnings.push('内置技能目录加载失败，可重试或跳过。');
    const builtin: SkillOption[] = parsed.success
      ? parsed.data.skills.data.map((item) => ({
          id: item.skill_id,
          label: item.display_title || item.skill_id,
          type: parsed.data.skills.type === 'custom' ? 'custom' : 'builtin',
          description: item.description,
        }))
      : [];
    return {
      memories,
      skills: [...new Map([...builtin, ...custom].map((item) => [`${item.type}:${item.id}`, item])).values()],
      warnings,
    };
  }
  async contract(sessionId: string, family: 'agents' | 'memory_stores') {
    const parsed = z
      .object({ defaultValue: z.record(z.unknown()), createSchema: z.record(z.unknown()) })
      .safeParse(await this.get(sessionId, `/v1/configuration-schema/${family}`));
    if (!parsed.success) throw new CliError('PROTOCOL_ERROR', '智能体配置契约不完整，未创建资源');
    return parsed.data;
  }
  async create(
    sessionId: string,
    family: 'agents' | 'memory_stores',
    body: Record<string, unknown>,
  ): Promise<string> {
    const raw = (
      await this.client.request(`${base}/v1/${family}`, body, { sessionId, native: true, write: true })
    ).data;
    const id = text(object(raw).id) || text(object(raw).entityId);
    if (!id) throw new CliError('OUTCOME_UNKNOWN', '资源创建响应缺少 ID，请到网页核对，勿重复创建');
    return id;
  }
  async rewrite(
    sessionId: string,
    request: { messageId: string; toolId: string; currentDescription: string; instruction: string },
  ) {
    const raw = (
      await this.client.request(
        `${base}/ai-rewrite-description`,
        { ...request, locale: this.client.config.locale },
        { sessionId, write: true },
      )
    ).data;
    const description = text(object(raw).workDescription);
    if (!description?.trim() || description.length > 4000)
      throw new CliError('PROTOCOL_ERROR', '智能修改结果无效，保留当前设定');
    return description;
  }
}
