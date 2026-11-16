/** Universal Ask 的回答为编号文本，继续普通 Chat。@author xiuyu.yi */
import { resolveAnswers } from '../questions.js';
import type { ReplyHandler } from './types.js';
import { AUTO_TEST_OPERATION_KEY, AUTO_TEST_SOURCE_KEY } from '../../conversation/auto-test.js';
import { CODE_REVIEW_OPERATION_KEY, CODE_REVIEW_SOURCE_KEY } from '../../conversation/code-review.js';
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
  const { autoTest, codeReview } = await runtime.resolveChecks(binding.view);
  return runtime.command.chat({
    sessionId: binding.round.sessionId,
    content,
    // 与 Glow 一致：标记原问卷身份，并保留检查流程的轮次字段。
    roundExtra: {
      questionnaireSubmission: JSON.stringify([
        binding.interaction.source.messageId,
        binding.interaction.source.contentId,
      ]),
      ...(autoTest
        ? {
            [AUTO_TEST_OPERATION_KEY]: autoTest.phase,
            [AUTO_TEST_SOURCE_KEY]: autoTest.sourceMessageId,
          }
        : {}),
      ...(codeReview
        ? {
            [CODE_REVIEW_OPERATION_KEY]: 'repair',
            [CODE_REVIEW_SOURCE_KEY]: codeReview.sourceMessageId,
          }
        : {}),
    },
    ...(autoTest
      ? {
          businessParams: { business_type: autoTest.phase === 'test' ? 'auto_test' : 'casual_chat' },
        }
      : {}),
    ...(codeReview
      ? {
          businessParams: { business_type: 'casual_chat' },
        }
      : {}),
  });
};
