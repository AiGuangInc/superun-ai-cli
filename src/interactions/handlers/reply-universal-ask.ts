/** Universal Ask 的回答为编号文本，继续普通 Chat。@author xiuyu.yi */
import { resolveAnswers } from '../questions.js';
import type { ReplyHandler } from './types.js';
export const replyUniversalAsk: ReplyHandler = async ({ runtime, binding, input }) => {
  const answers = resolveAnswers(binding.interaction.questions, input.answers);
  const content = answers
    .map(
      (answer, index) =>
        `${index + 1}. ${answer.question.question}\n${[...answer.selectedOptions, answer.otherValue]
          .filter(Boolean)
          .map((value) => `   - ${value}`)
          .join('\n')}`,
    )
    .join('\n');
  return runtime.command.chat({ sessionId: binding.round.sessionId, content });
};
