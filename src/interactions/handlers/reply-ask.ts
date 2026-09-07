/** Native Ask 严格构造 ToolResult，含跳过与 preview。@author xiuyu.yi */
import { resolveAnswers } from '../questions.js';
import { object, requiredText } from '../../contracts/value.js';
import type { ReplyHandler } from './types.js';

export const replyAsk: ReplyHandler = async ({ runtime, binding, input }) => {
  const { questions, source } = binding.interaction;
  const answers: Record<string, string> = {},
    annotations: Record<string, unknown> = {};
  const metadata = { ...object(binding.item.payload.metadata) };
  if (input.action === 'SKIP') {
    for (const question of questions) {
      answers[question.question] = '';
      annotations[question.question] = { notes: '用户选择跳过本次提问，请继续处理。' };
    }
    metadata.skipped = true;
    metadata.notes = '用户选择跳过本次提问，请继续处理。';
  } else
    for (const answer of resolveAnswers(questions, input.answers)) {
      answers[answer.question.question] = [...answer.selectedOptions, answer.otherValue]
        .filter(Boolean)
        .join(', ');
      const index = answer.selectedIndices[0];
      const preview = index === undefined ? undefined : answer.question.options[index]?.preview;
      if (!answer.question.multiSelect && preview) annotations[answer.question.question] = { preview };
    }
  return runtime.command.reply(binding.round.sessionId, requiredText(source.toolId, 'toolId'), {
    questions: binding.item.payload.questions,
    answers,
    annotations,
    metadata,
  });
};
