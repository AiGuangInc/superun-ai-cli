/** 保存需求问卷后直接生成风格。@author xiuyu.yi */
import { resolveAnswers } from '../questions.js';
import { object } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';
import type { ReplyHandler } from './types.js';

export const replyPrd: ReplyHandler = async ({ runtime, binding, input }) => {
  const { source, questions } = binding.interaction;
  const sessionId = binding.round.sessionId;
  const answers = resolveAnswers(questions, input.answers);
  const states = answers.map((answer) => ({
    question: answer.question.question,
    selectedIndices: answer.selectedIndices,
    selectedOptions: answer.selectedOptions,
    otherSelected: !!answer.otherValue,
    otherValue: answer.otherValue,
  }));
  const name = `internal/prd_answers__${source.messageId}__${source.contentId.replace('.', '_')}.json`;
  await runtime.command.saveAttachment(sessionId, name, states, binding.round.anchorUserMessageId);
  await runtime.command.contentExtra({
    sessionId,
    messageId: source.messageId,
    contentId: source.contentId,
    extra: { ...object(binding.item.payload.extra), prdAnswersAttachment: name },
  });
  const content = answers
    .map(
      (answer, index) =>
        `${index + 1}. ${answer.question.question}\n${[...answer.selectedOptions, answer.otherValue]
          .filter(Boolean)
          .map((value) => `   - ${value}`)
          .join('\n')}`,
    )
    .join('\n');
  const response = await runtime
    .generateStyles(sessionId, content, binding.round.anchorUserMessageId)
    .catch((error) => {
      if (error instanceof CliError)
        throw new CliError(error.code, error.message, {
          ...error.details,
          sessionId,
          instruction:
            error.code === 'BUSINESS_ERROR'
              ? `本次方案生成失败：${error.message}。需求答案已保存，处理失败原因后回复“重试生成”，使用本次已保存的答案重新提交当前问卷。`
              : '请先查看进度，确认本次请求结果后再决定下一步，不重复生成。',
        });
      throw error;
    });
  try {
    await runtime.command.contentExtra({
      sessionId,
      messageId: source.messageId,
      contentId: source.contentId,
      extra: { ...object(binding.item.payload.extra), prdAnswersAttachment: name, submitPrdQuestions: '1' },
    });
  } catch {
    throw new CliError('OUTCOME_UNKNOWN', '方案生成已提交，问卷提交标记同步未确认；请查看进度，勿重复生成', {
      sessionId,
    });
  }
  return response;
};
