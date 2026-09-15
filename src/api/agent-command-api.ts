/** 对话创建、工具回复和项目内容更新。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import type { JsonObject } from '../contracts/value.js';
import { object } from '../contracts/value.js';
import { AUTO_TEST_OPERATION_KEY, AUTO_TEST_SOURCE_KEY } from '../conversation/auto-test.js';
import { CODE_REVIEW_OPERATION_KEY, CODE_REVIEW_SOURCE_KEY } from '../conversation/code-review.js';

export type ChatInput = {
  sessionId?: string;
  content: string;
  model?: string;
  minDuration?: number;
  previewVersionId?: number;
  workspaceId?: string;
  mode?: number;
  framework?: number;
  sessionExtra?: Record<string, string>;
  roundExtra?: Record<string, string>;
  businessParams?: JsonObject;
  preReplyMessageId?: string;
  parallelSelectRequest?: JsonObject;
  excludedInheritedRoundExtraKeys?: Array<string>;
  attachments?: Array<JsonObject>;
};
const PREFIX = '/api/uxa-center/agent/AgentCommand';
export class AgentCommandApi {
  constructor(private readonly client: ApiClient) {}
  async chat(input: ChatInput): Promise<JsonObject> {
    return object(
      await this.client.call(
        `${PREFIX}/glowChat`,
        {
          ...input,
          ...(input.sessionId ? { previewVersionId: input.previewVersionId ?? 0 } : {}),
          mode: input.mode ?? 6,
          framework: input.framework ?? 6,
          roundExtra: {
            [AUTO_TEST_OPERATION_KEY]: 'none',
            [CODE_REVIEW_OPERATION_KEY]: 'none',
            ...input.roundExtra,
            humanizeVer: '1',
          },
          ...(input.sessionId
            ? {
                excludedInheritedRoundExtraKeys: [
                  'stage0Intro',
                  'stage0SkillUnavailable',
                  // Center 在合并本轮字段后执行排除；不能把本轮显式写入的来源也删掉。
                  ...(input.roundExtra?.[AUTO_TEST_SOURCE_KEY] ? [] : [AUTO_TEST_SOURCE_KEY]),
                  ...(input.roundExtra?.[CODE_REVIEW_SOURCE_KEY] ? [] : [CODE_REVIEW_SOURCE_KEY]),
                  ...(input.excludedInheritedRoundExtraKeys ?? []),
                ],
              }
            : {}),
        },
        true,
      ),
    );
  }
  async parallel(input: JsonObject): Promise<JsonObject> {
    return object(await this.client.call(`${PREFIX}/glowParallelChat`, input, true));
  }
  async checkBalance(sessionId: string): Promise<void> {
    await this.client.call('/api/uxa-center/agent/AgentToken/checkSessionTokenBalance', { sessionId });
  }
  async retry(sessionId: string, messageId: string, replyMessageId?: string): Promise<JsonObject> {
    return object(await this.client.call(`${PREFIX}/retry`, { sessionId, messageId, replyMessageId }, true));
  }
  async viewDemo(sessionId: string, planningChoiceId?: string): Promise<JsonObject> {
    return object(
      await this.client.call(
        `${PREFIX}/fakeGlowChat`,
        {
          sessionId,
          content: '查看演示',
          agentContents: [{ content: '你可以通过对话，继续完善演示。我也可以帮你推荐其他演示功能。' }],
          skipAgent: true,
          duration: 3,
          roundExtra: {
            business_type: 'fake_confirm_generate_more_demo',
            showConfirmGenerateMoreDemo: '1',
            ...(planningChoiceId ? { cliPlanAfterStyle: planningChoiceId } : {}),
          },
        },
        true,
      ),
    );
  }
  async stop(sessionId: string, scope: 'own' | 'all', messageId?: string): Promise<void> {
    await this.client.call(
      `${PREFIX}/stop`,
      { sessionId, messageId, stopMain: scope === 'all' ? 1 : 2, stopSubAgent: scope === 'all' ? 1 : 2 },
      true,
    );
  }
  async reply(sessionId: string, toolId: string, toolResult?: unknown): Promise<JsonObject> {
    return object(
      await this.client.call(
        `${PREFIX}/batchReplyToolCall`,
        {
          sessionId,
          toolCallReplies: [
            { toolId, ...(toolResult === undefined ? {} : { toolResult: JSON.stringify(toolResult) }) },
          ],
        },
        true,
      ),
    );
  }
  async replySingle(input: JsonObject): Promise<JsonObject> {
    return object(await this.client.call(`${PREFIX}/replyToolCall`, input, true));
  }
  async messageExtra(sessionId: string, messageId: string, extra: JsonObject): Promise<void> {
    await this.client.call(`${PREFIX}/updateMessageExtra`, { sessionId, messageId, extra }, true);
  }
  async saveAttachment(
    sessionId: string,
    name: string,
    content: unknown,
    replyMessageId?: string,
  ): Promise<void> {
    await this.client.call(
      `${PREFIX}/safeSaveAttachment`,
      { sessionId, name, content: JSON.stringify(content), operationMode: 1, replyMessageId },
      true,
    );
  }
  async contentExtra(input: {
    sessionId: string;
    messageId: string;
    contentId: string;
    extra: JsonObject;
  }): Promise<void> {
    await this.client.call(`${PREFIX}/updateContentExtra`, input, true);
  }
  async sessionExtra(sessionId: string, extra: Record<string, string>): Promise<void> {
    await this.client.call(`${PREFIX}/updateSessionExtra`, { sessionId, extra }, true);
  }
}
