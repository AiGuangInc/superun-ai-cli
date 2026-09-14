/** 项目、附件和风格结果查询。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import { list, object, text } from '../contracts/value.js';
import type { JsonObject } from '../contracts/value.js';
import { z } from 'zod';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';

const referenceSourcesSchema = z.array(
  z.object({
    messageId: z.string(),
    role: z.number(),
    roundExtra: z.record(z.unknown()).default({}),
    parsedContents: z.array(z.string()),
  }),
);

const PREFIX = '/api/uxa-center/agent/AgentQuery';
export class AgentQueryApi {
  constructor(private readonly client: ApiClient) {}
  async messageReferenceSource(sessionId: string, messageId: string) {
    const rows = parseWire(
      referenceSourcesSchema,
      await this.client.call(`${PREFIX}/batchQueryMessageReferenceSources`, {
        sessionId,
        messageIds: [messageId],
      }),
    );
    if (rows.length !== 1 || rows[0]?.messageId !== messageId || rows[0].role !== 1)
      throw new CliError('PROTOCOL_ERROR', '后台回执的来源消息缺失或不一致，请重新查询当前状态');
    return rows[0];
  }
  async sessions(input: JsonObject): Promise<JsonObject> {
    return object(await this.client.call(`${PREFIX}/pageQuerySessionByLastId`, input));
  }
  async extra(sessionId: string): Promise<JsonObject> {
    return object(await this.client.call(`${PREFIX}/querySessionExtra`, { sessionId }));
  }
  async snapshots(sessionId: string): Promise<unknown> {
    return this.client.call('/api/uxa-center/agent/SessionSnapshot/pageQuerySessionSnapshotHistory', {
      sessionId,
      page: 1,
      pageSize: 50,
    });
  }
  async developmentSnapshots(sessionId: string, page: number): Promise<unknown> {
    return this.client.call('/api/uxa-center/agent/SessionSnapshot/pageQuerySessionSnapshotHistoryV2', {
      sessionId,
      previewVersionId: 0,
      page,
      pageSize: 50,
    });
  }
  async parallel(sessionId: string, preReplyMessageId: string): Promise<JsonObject> {
    return object(
      await this.client.call(`${PREFIX}/queryAllParallelInfos`, { sessionId, preReplyMessageId }),
    );
  }
  async attachments(sessionId: string, names: Array<string> = []): Promise<Array<JsonObject>> {
    const response = await this.client.call(`${PREFIX}/querySessionAttachmentsExcludeInternalAndCompiled`, {
      sessionId,
      filenamesForAttachmentContent: names,
      withContent: names.length > 0,
    });
    return list(response)
      .map(object)
      .filter((item) => {
        const name = text(item.name) ?? '';
        return (
          !!name &&
          !name
            .split('/')
            .some((part) => /^(?:internal|compiled|\.superun|\._shared_|\.env(?:\..*)?)$/.test(part))
        );
      })
      .map((item) => ({
        name: item.name,
        type: item.type,
        size: item.size,
        ...(names.includes(String(item.name)) ? { content: item.content } : {}),
      }));
  }
  async features(sessionId: string, replyMessageId?: string): Promise<Array<JsonObject>> {
    const raw = await this.client.call(`${PREFIX}/queryAttachment`, {
      sessionId,
      name: 'internal/features.json',
      replyMessageId,
    });
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
      return list(JSON.parse(raw))
        .map(object)
        .filter((item) => typeof item.title === 'string');
    } catch {
      return [];
    }
  }
}
