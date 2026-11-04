/** 仅供 app 命令调用的原生业务接口。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { parseWire, recentlySchema, pipelineSchema } from '../contracts/node-wire.js';
import { object, type JsonObject } from '../contracts/value.js';
import {
  accountSchema,
  buildSchema,
  configSchema,
  installSchema,
  signingSchema,
  threadSchema,
} from './contracts.js';
import type { AppPlatform } from './contracts.js';

export class AppApi {
  constructor(readonly client: ApiClient) {}
  async call(method: string, body: JsonObject, write = false): Promise<unknown> {
    return this.client.call(`/api/uxa-center/support/AppBuild/${method}`, body, write);
  }
  async config(sessionId: string) {
    return parseWire(configSchema, await this.call('queryAppConfig', { sessionId }));
  }
  async accounts(sessionId: string) {
    return parseWire(z.array(accountSchema), await this.call('queryDeveloperAccounts', { sessionId }));
  }
  async signing(sessionId: string) {
    return parseWire(z.array(signingSchema), await this.call('querySigningStatus', { sessionId }));
  }
  async builds(sessionId: string, platform: AppPlatform, limit = 200) {
    return parseWire(
      z.array(buildSchema),
      await this.call('queryAppBuildRecords', { sessionId, platform, limit }),
    );
  }
  async install(taskId: string) {
    return parseWire(installSchema.nullable(), await this.call('queryAppInstall', { taskId }));
  }
  async threads(sessionId: string, consultId?: string) {
    return parseWire(
      z.object({ consults: z.array(threadSchema) }),
      await this.client.call('/web-api/conversation-v2/consult-threads', {
        sessionId,
        previewVersionId: 0,
        ...(consultId ? { idLE: consultId, limit: 1 } : { limit: 100 }),
      }),
    ).consults;
  }
  async consultation(sessionId: string) {
    return parseWire(
      recentlySchema,
      await this.client.call('/web-api/conversation-v2/consult-detail-recently', {
        sessionId,
        toolActivityVersion: 2,
        previewVersionId: 0,
        withAttachment: false,
        withAllAttachmentContent: false,
      }),
    );
  }
  async mainline(sessionId: string, beforeMessageId?: string) {
    return parseWire(
      pipelineSchema,
      await this.client.call('/web-api/conversation-v2/unified-history', {
        sessionId,
        previewVersionId: 0,
        timelineVariant: 'work_block',
        toolActivityVersion: 2,
        lanes: {
          chain: { hasMore: true, ...(beforeMessageId ? { lastMessageId: beforeMessageId } : {}) },
          consultIndex: { hasMore: false },
        },
      }),
    );
  }
  async prepareConsultation(sessionId: string) {
    return parseWire(
      z.object({ previewVersionId: z.number(), preReplyMessageId: z.string().nullish() }),
      await this.client.call('/api/uxa-center/agent/SessionPreviewVersion/prepareConsultChat', {
        sessionId,
        previewVersionId: 0,
      }),
    );
  }
  async consult(body: JsonObject) {
    return object(await this.client.call('/api/uxa-center/agent/AgentCommand/glowConsultChat', body, true));
  }
  async planAttachment(sessionId: string, replyMessageId: string) {
    return parseWire(
      z.string(),
      await this.client.call('/api/uxa-center/agent/AgentQuery/queryAttachment', {
        sessionId,
        replyMessageId,
        name: 'internal/features.json',
      }),
    );
  }
  async devices(sessionId: string, platform: AppPlatform, bundleName?: string) {
    const method = platform === 'ios' ? 'queryIosBuildOptions' : 'queryHarmonyBuildOptions';
    return parseWire(
      z.object({
        devices: z.array(z.object({ id: z.string(), name: z.string() })),
        apps: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
        testDeviceIds: z.array(z.string()).optional(),
      }),
      await this.call(method, { sessionId, ...(platform === 'harmony' ? { bundleName } : {}) }),
    );
  }
}
