/** Native Ask 的协议 pending 状态可跨越多个显示轮。@author xiuyu.yi */
import { bind, pendingTool, toolId } from '../context.js';
import type { InteractionParser } from '../context.js';
import { ANSWER_JSON_SCHEMA, projectQuestions } from '../questions.js';

export const parseAskTool: InteractionParser = (context) => {
  if (!pendingTool(context.item) || !toolId(context.item)) return undefined;
  const questions = projectQuestions(context.item.payload.questions);
  return bind(context, 'ASK_USER_TOOL', {
    questions,
    actions: questions.length ? ['SUBMIT', 'SKIP'] : ['SKIP'],
    schema: ANSWER_JSON_SCHEMA,
  });
};
