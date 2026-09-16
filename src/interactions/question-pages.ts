/** 普通问卷逐题展示，答案齐全后仍按原协议整组提交。@author xiuyu.yi */
import { z } from 'zod';
import type { InteractionBinding } from './context.js';
import type { JsonObject } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { InteractionDraftStore, fingerprint } from './draft-store.js';
import { ANSWER_JSON_SCHEMA, resolveAnswers } from './questions.js';
const answer = z
  .object({
    questionId: z.string(),
    selectedIndices: z.array(z.number().int().nonnegative()).default([]),
    otherValue: z.string().default(''),
  })
  .strict();
const draftSchema = z.object({
  revision: z.number().int().nonnegative(),
  index: z.number().int().nonnegative(),
  answers: z.array(answer),
  sending: z.boolean().default(false),
});
export const isQuestionnaire = (binding: InteractionBinding) =>
  ['PRD_CLARIFICATION', 'ASK_USER_TOOL', 'ASK_USER_MESSAGE'].includes(binding.interaction.kind) &&
  binding.interaction.questions.length > 0;
export class QuestionPages {
  constructor(private readonly store: InteractionDraftStore) {}
  private key(binding: InteractionBinding) {
    return `${binding.interaction.interactionId}:${fingerprint(binding.interaction.questions)}`;
  }
  private async read(binding: InteractionBinding) {
    const raw = await this.store.read(this.key(binding));
    if (raw === undefined)
      return { revision: 0, index: 0, answers: [], sending: false } as z.infer<typeof draftSchema>;
    const parsed = draftSchema.safeParse(raw);
    if (!parsed.success || parsed.data.index >= binding.interaction.questions.length)
      throw new CliError('PROTOCOL_ERROR', '问卷草稿损坏，未提交回答');
    return parsed.data;
  }
  async project(binding: InteractionBinding): Promise<InteractionBinding> {
    if (!isQuestionnaire(binding)) return binding;
    const draft = await this.read(binding),
      interaction = binding.interaction;
    const question = interaction.questions[draft.index];
    if (!question) throw new CliError('PROTOCOL_ERROR', '问题页码无效');
    const revision = fingerprint([this.key(binding), draft.revision]);
    return {
      ...binding,
      interaction: {
        ...interaction,
        questions: draft.sending ? [] : [question],
        actions: draft.sending ? [] : [...interaction.actions, ...(draft.index > 0 ? ['BACK'] : [])],
        page: {
          id: question.id,
          revision,
          index: draft.index + 1,
          total: interaction.questions.length,
          title: `第 ${draft.index + 1} / ${interaction.questions.length} 题`,
        },
        details: {
          ...interaction.details,
          savedAnswers: draft.answers,
          ...(draft.sending ? { notice: '回答已提交或结果尚待核对，请查询服务端状态，勿重复提交。' } : {}),
        },
        answerSchema: {
          ...ANSWER_JSON_SCHEMA,
          required: ['action'],
          properties: {
            ...ANSWER_JSON_SCHEMA.properties,
            action: {
              enum: draft.sending ? [] : [...interaction.actions, ...(draft.index > 0 ? ['BACK'] : [])],
            },
            pageRevision: { const: revision },
          },
          allOf: [
            {
              if: { properties: { action: { enum: ['SUBMIT', 'GENERATE_STYLES'] } } },
              then: { required: ['answers'] },
            },
            { if: { properties: { action: { const: 'BACK' } } }, then: { required: ['pageRevision'] } },
          ],
        },
      },
    };
  }
  async reply(
    binding: InteractionBinding,
    input: JsonObject,
    send: (input: JsonObject) => Promise<JsonObject>,
  ): Promise<JsonObject> {
    return this.store.locked(this.key(binding), async () => {
      const draft = await this.read(binding),
        interaction = binding.interaction;
      if (draft.sending)
        throw new CliError('OUTCOME_UNKNOWN', '本组回答已提交或结果未确认，请查询状态，勿重复提交');
      if (Object.keys(input).some((key) => !['action', 'answers', 'pageRevision', 'saveOnly'].includes(key)))
        throw new CliError('INVALID_ARGUMENT', '回答包含不支持的字段');
      if (input.saveOnly !== undefined && typeof input.saveOnly !== 'boolean')
        throw new CliError('INVALID_ARGUMENT', 'saveOnly 必须为布尔值');
      const action =
        input.action ?? (interaction.kind === 'PRD_CLARIFICATION' ? 'GENERATE_STYLES' : 'SUBMIT');
      const revision = fingerprint([this.key(binding), draft.revision]);
      if (input.pageRevision !== undefined && input.pageRevision !== revision)
        throw new CliError('STALE_INTERACTION', '问题页面已变化，请重新查询');
      if (action === 'BACK') {
        if (input.pageRevision !== revision || draft.index === 0)
          throw new CliError('INVALID_ARGUMENT', '无法返回上一题，请使用当前页面版本');
        draft.index--;
        draft.revision++;
        await this.store.write(this.key(binding), draft);
        return { localInteraction: true, sessionId: binding.round.sessionId };
      }
      if (!interaction.actions.includes(String(action)))
        throw new CliError('INVALID_ARGUMENT', '当前交互不支持该动作');
      if (action !== 'SKIP') {
        const parsed = z.array(answer).min(1).safeParse(input.answers);
        if (!parsed.success) throw new CliError('INVALID_ARGUMENT', '请提供当前问题的有效答案');
        // 内部处理器接收整组或部分答案；部分回答必须携带页面版本。
        if (parsed.data.length !== interaction.questions.length && input.pageRevision !== revision)
          throw new CliError('STALE_INTERACTION', '逐题回答需要携带当前 pageRevision');
        const ids = parsed.data.map((item) => item.questionId);
        const questions = interaction.questions.filter((item) => ids.includes(item.id));
        resolveAnswers(questions, parsed.data);
        const byId = new Map(draft.answers.map((item) => [item.questionId, item]));
        parsed.data.forEach((item) => byId.set(item.questionId, item));
        draft.answers = [...byId.values()];
        const missing = interaction.questions.findIndex((item) => !byId.has(item.id));
        if (missing >= 0 || input.saveOnly === true) {
          draft.index = missing >= 0 ? missing : interaction.questions.length - 1;
          draft.revision++;
          await this.store.write(this.key(binding), draft);
          return { localInteraction: true, sessionId: binding.round.sessionId };
        }
      }
      draft.sending = true;
      draft.revision++;
      await this.store.write(this.key(binding), draft);
      try {
        return await send({ action, ...(action === 'SKIP' ? {} : { answers: draft.answers }) });
      } catch (error) {
        if (
          error instanceof CliError &&
          ['INVALID_ARGUMENT', 'AUTH_REQUIRED', 'BUSINESS_ERROR', 'STALE_INTERACTION'].includes(error.code)
        ) {
          draft.sending = false;
          await this.store.write(this.key(binding), draft);
        }
        throw error;
      }
    });
  }
}
