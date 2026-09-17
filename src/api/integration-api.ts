/** 插件交互的连接与状态接口。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import { object } from '../contracts/value.js';
import type { JsonObject } from '../contracts/value.js';
import { preparePluginConfig } from '../interactions/plugin-config.js';
import { CliError } from '../output/exit-codes.js';
export class IntegrationApi {
  constructor(private readonly client: ApiClient) {}
  async connect(
    sessionId: string,
    integration: string,
    payload: JsonObject,
    toolId?: string,
    suggested: JsonObject = {},
  ): Promise<JsonObject> {
    if (integration === 'CUSTOM_MINIPROGRAM' && toolId)
      throw new CliError(
        'UNSUPPORTED_INTERACTION',
        '小程序配置确认需在网页完成；基础插件启停可使用 chat plugin 命令',
      );
    const current = await this.status(sessionId, integration);
    if (current.integrationStatus === 'ENABLED') return current;
    if (
      ![
        'UNKNOWN',
        'NOT_ENABLED',
        'DISABLED',
        'PAUSED',
        'ENABLING',
        'RESTORING',
        'PAUSING',
        'DISABLING',
      ].includes(String(current.integrationStatus))
    )
      throw new CliError('PROTOCOL_ERROR', '插件状态响应无效，请查询后继续', {
        sessionId,
        pluginId: integration,
      });
    if (!toolId && ['ENABLING', 'RESTORING'].includes(String(current.integrationStatus))) return current;
    const config = preparePluginConfig(integration, payload, current, suggested);
    const facade =
      integration === 'ASR'
        ? 'AsrIntegration'
        : integration === 'FACEID'
          ? 'FaceIdIntegration'
          : 'SessionIntegration';
    return object(
      await this.client.call(
        `/api/uxa-center/agent/${facade}/connectIntegration`,
        { sessionId, integration, payload: config, toolId },
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
  async batchStatus(sessionId: string, integrations: string[]): Promise<JsonObject> {
    return object(
      await this.client.call('/api/uxa-center/agent/SessionIntegration/batchIntegrationStatus', {
        sessionId,
        integrations,
      }),
    );
  }
  async disable(sessionId: string, integration: string): Promise<JsonObject> {
    return object(
      await this.client.call(
        '/api/uxa-center/agent/SessionIntegration/disableIntegration',
        { sessionId, integration },
        true,
      ),
    );
  }
}
