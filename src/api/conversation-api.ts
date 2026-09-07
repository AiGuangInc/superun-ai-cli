/** 会话消息读取、增量快照和密钥回复。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import { parseWire, pipelineSchema, recentlySchema } from '../contracts/node-wire.js';
import type { NodePipeline, NodeRecently } from '../contracts/node-wire.js';
import type { JsonObject } from '../contracts/value.js';
import { object } from '../contracts/value.js';

export class ConversationApi {
  constructor(private readonly client: ApiClient) {}
  async recently(sessionId: string): Promise<NodeRecently> {
    return parseWire(
      recentlySchema,
      await this.client.call('/web-api/conversation-v2/unified-recently', {
        sessionId,
        withAttachment: false,
        withAllAttachmentContent: false,
        timelineVariant: 'work_block',
      }),
    );
  }
  async snapshot(
    sessionId: string,
    messageId: string,
    etag?: string,
  ): Promise<{ status: number; etag?: string; pipeline?: NodePipeline }> {
    const response = await this.client.request(
      '/web-api/conversation-v2/message-snapshot',
      { sessionId, messageId, timelineVariant: 'work_block' },
      { etag },
    );
    return {
      status: response.status,
      etag: response.etag,
      ...(response.status === 304 ? {} : { pipeline: parseWire(pipelineSchema, response.data) }),
    };
  }
  async replySecret(input: JsonObject): Promise<JsonObject> {
    return object(await this.client.call('/web-api/conversation/reply-add-secret', input, true));
  }
}
