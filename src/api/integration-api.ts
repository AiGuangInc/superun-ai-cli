/** 插件交互的连接与状态接口。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import { object } from '../contracts/value.js';
import type { JsonObject } from '../contracts/value.js';
export class IntegrationApi {
  constructor(private readonly client: ApiClient) {}
  async connect(
    sessionId: string,
    integration: string,
    payload: JsonObject,
    toolId?: string,
  ): Promise<JsonObject> {
    return object(
      await this.client.call(
        '/api/uxa-center/agent/SessionIntegration/connectIntegration',
        { sessionId, integration, payload, toolId },
        true,
      ),
    );
  }
  async status(sessionId: string, integration: string): Promise<JsonObject> {
    return object(
      await this.client.call('/api/uxa-center/agent/SessionIntegration/integrationStatus', {
        sessionId,
        integration,
      }),
    );
  }
}
