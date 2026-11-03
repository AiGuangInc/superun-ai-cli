/** 对话创建、工具回复和项目内容更新。@author xiuyu.yi */
import type { ApiClient } from '../transport/api-client.js';
import type { JsonObject } from '../contracts/value.js';
import type { InputAttachment } from './upload-api.js';
import { object } from '../contracts/value.js';
import { AUTO_TEST_OPERATION_KEY, AUTO_TEST_SOURCE_KEY } from '../conversation/auto-test.js';
import { CODE_REVIEW_OPERATION_KEY, CODE_REVIEW_SOURCE_KEY } from '../conversation/code-review.js';
import { AgentQueryApi } from './agent-query-api.js';
import { CliError } from '../output/exit-codes.js';

export type ChatInput = {
  sessionId?: string;
  content: string;
  attachments?: InputAttachment[];
  model?: string;
  minDuration?: number;
  previewVersionId?: number;
  workspaceId?: string;
  mode?: number;
  framework?: number;
  autoMode?: 1;
  sessionExtra?: Record<string, string>;
  roundExtra?: Record<string, string>;
  businessParams?: JsonObject;
  preReplyMessageId?: string;
  parallelSelectRequest?: JsonObject;
  excludedInheritedRoundExtraKeys?: Array<string>;
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
    let acknowledged = false;
    try {
      acknowledged =
        (await this.client.call(`${PREFIX}/updateSessionExtra`, { sessionId, extra }, true)) === true;
    } catch (error) {
      // 超时可能发生在落库之后；只回读，不重发写请求。认证、业务拒绝和中断仍保留原错误。
      if (!(error instanceof CliError) || error.code !== 'OUTCOME_UNKNOWN') throw error;
    }
    await this.verifySessionExtra(sessionId, extra, acknowledged);
  }
  async verifySessionExtra(
    sessionId: string,
    extra: Record<string, string>,
    acknowledged?: boolean,
  ): Promise<void> {
    const details = { sessionId, phase: 'SESSION_EXTRA_SYNC', retryable: false, acknowledged };
    let current: JsonObject;
    try {
      current = await new AgentQueryApi(this.client).extra(sessionId);
    } catch (error) {
      if (error instanceof CliError && ['AUTH_REQUIRED', 'INTERRUPTED'].includes(error.code)) throw error;
      throw new CliError(
        'OUTCOME_UNKNOWN',
        '会话标记已提交，但回读未确认；请查询原会话，勿重发业务请求',
        details,
      );
    }
    const missingKeys = Object.keys(extra).filter(
      (key) => !Object.hasOwn(current, key) || String(current[key]) !== extra[key],
    );
    // false 可能只是没有发生变更；以实际落库值确认幂等成功，不能仅凭接口返回 true 判定完成。
    if (missingKeys.length)
      throw new CliError('OUTCOME_UNKNOWN', '会话标记尚未同步；请查询当前会话确认，勿重发业务请求', {
        ...details,
        missingKeys,
      });
  }
}
