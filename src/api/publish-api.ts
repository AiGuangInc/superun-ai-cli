/** 发布记录查询和站点公开状态管理。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import { object } from '../contracts/value.js';
import type { JsonObject } from '../contracts/value.js';
export class PublishApi {
  constructor(private readonly client: ApiClient) {}
  async status(sessionId: string): Promise<JsonObject> {
    return object(
      await this.client.call('/api/uxa-center/agent/AgentQuery/queryPublishLogInfo', { sessionId }),
    );
  }
  async start(input: {
    sessionId: string;
    encryptedId: string;
    targetRegion?: string;
    noIndex?: boolean;
    acknowledgedCloudServiceFee?: boolean;
  }): Promise<unknown> {
    return this.client.call('/api/uxa-center/agent/AgentCommand/publishNewLogV2', input, true);
  }
  async visibility(sessionId: string, isPublic: boolean): Promise<void> {
    await this.client.call(
      '/api/uxa-center/agent/AgentCommand/changePublicStatus',
      { sessionId, publicStatus: isPublic ? 1 : 0 },
      true,
    );
  }
}
