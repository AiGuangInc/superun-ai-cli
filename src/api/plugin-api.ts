/** 插件的脱敏查询与启停；补齐 Glow 已公开的集成入口，不修改插件内部实现。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import { object, text, type JsonObject } from '../contracts/value.js';
import { IntegrationApi } from './integration-api.js';
import { integrationKey } from '../interactions/handlers/reply-plugin.js';
import { getSuperunHostingDomain } from '../config/runtime-config.js';
import { CliError } from '../output/exit-codes.js';

// ProjectPlugin 目录尚未包含的 Glow 基础插件；Skill 卡片不属于集成生命周期。
const GLOW_PLUGINS: Record<string, string> = {
  SUPERUN_PAYMENT: 'superun 支付',
  MEDIA_TRANSCODE: '音视频转码',
  AMAP: '高德地图',
  FACEID: '人脸核验',
  SMS: '短信',
  CUSTOM_MINIPROGRAM: '微信小程序',
  DINGTALK: '钉钉',
  WECOM: '企业微信',
  FEISHU: '飞书',
  STRIPE: 'Stripe 支付',
};

export class PluginApi {
  private readonly integration: IntegrationApi;
  constructor(private readonly client: ApiClient) {
    this.integration = new IntegrationApi(client);
  }
  private visible(pluginId: string) {
    return (
      pluginId !== 'SUPERUN_PAYMENT' || getSuperunHostingDomain(this.client.config.endpoint) === 'superun.yun'
    );
  }
  private state(response: JsonObject, pluginId: string): JsonObject {
    const state = text(response.integrationStatus);
    if (!state) throw new CliError('PROTOCOL_ERROR', '接口未返回插件状态，请重新查询', { pluginId });
    return { pluginId, state };
  }
  async list(sessionId: string): Promise<JsonObject> {
    const response = object(
      await this.client.call('/api/uxa-center/agent/ProjectPlugin/list', { sessionId }),
    );
    if (!Array.isArray(response.plugins)) throw new CliError('PROTOCOL_ERROR', '接口未返回插件目录');
    const plugins = response.plugins.map(object).filter((plugin) => this.visible(String(plugin.pluginId)));
    const existing = new Set(plugins.map((plugin) => plugin.pluginId));
    const missing = Object.keys(GLOW_PLUGINS).filter((id) => this.visible(id) && !existing.has(id));
    const statuses = missing.length ? await this.integration.batchStatus(sessionId, missing) : {};
    return {
      ...response,
      plugins: [
        ...plugins,
        ...missing.map((pluginId) => ({
          ...this.state(object(statuses[pluginId]), pluginId),
          displayName: GLOW_PLUGINS[pluginId],
        })),
      ],
    };
  }
  async operate(
    action: 'status' | 'enable' | 'disable',
    sessionId: string,
    pluginId: string,
  ): Promise<JsonObject> {
    const key = integrationKey(pluginId.trim()).toUpperCase();
    if (!this.visible(key))
      throw new CliError('INVALID_ARGUMENT', '此插件在当前站点不可用', { pluginId: key });
    if (Object.hasOwn(GLOW_PLUGINS, key)) {
      const response =
        action === 'status'
          ? await this.integration.status(sessionId, key)
          : action === 'enable'
            ? await this.integration.connect(sessionId, key, {})
            : await this.integration.disable(sessionId, key);
      return this.state(response, key);
    }
    // 保留已有入口，尤其是 Cloud 对历史 SUPABASE / SUPABASE_EMBED 的正确路由。
    return object(
      await this.client.call(
        `/api/uxa-center/agent/ProjectPlugin/${action}`,
        { sessionId, pluginId: key === 'SUPABASE_EMBED' ? 'SUPERUN_CLOUD' : key },
        action !== 'status',
      ),
    );
  }
}
