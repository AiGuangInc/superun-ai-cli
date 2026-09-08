/** 保存需求问卷后直接生成风格。@author xiuyu.yi */
import { resolveAnswers } from '../questions.js';
import { object } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';
import type { ReplyHandler } from './types.js';

export const replyPrd: ReplyHandler = async ({ runtime, binding, input }) => {
  const { source, questions } = binding.interaction;
  const sessionId = binding.round.sessionId;
  const answers = resolveAnswers(questions, input.answers);
  const count = input.styleCount ?? 2;
  if (!Number.isInteger(count) || typeof count !== 'number' || count < 1 || count > 4)
    throw new CliError('INVALID_ARGUMENT', 'styleCount 必须是 1 到 4 的整数');
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
    extra: { ...object(binding.item.payload.extra), prdAnswersAttachment: name, submitPrdQuestions: '1' },
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
  return runtime.generateStyles(sessionId, content, count, binding.round.anchorUserMessageId);
};
