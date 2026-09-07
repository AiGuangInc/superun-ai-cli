/** 插件的脱敏查询与启停。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import { object } from '../contracts/value.js';
import type { JsonObject } from '../contracts/value.js';
export class PluginApi {
  constructor(private readonly client: ApiClient) {}
  async list(sessionId: string): Promise<JsonObject> {
    return object(await this.client.call('/api/uxa-center/agent/ProjectPlugin/list', { sessionId }));
  }
  async operate(
    action: 'status' | 'enable' | 'disable',
    sessionId: string,
    pluginId: string,
  ): Promise<JsonObject> {
    return object(
      await this.client.call(
        `/api/uxa-center/agent/ProjectPlugin/${action}`,
        { sessionId, pluginId },
        action !== 'status',
      ),
    );
  }
}
