/** 将结构化提问转换为普通对话回答。@author xiuyu.yi */
import { bind } from '../context.js';
import type { InteractionParser } from '../context.js';
import { ANSWER_JSON_SCHEMA, projectQuestions } from '../questions.js';
import { CliError } from '../../output/exit-codes.js';

export const parseUniversalAsk: InteractionParser = (context) => {
  if (!context.current || context.round.status !== 'completed') return undefined;
  if (context.item.payload.malformed === true)
    throw new CliError('UNSUPPORTED_INTERACTION', '当前提问的结构不完整');
  const questions = projectQuestions(context.item.payload.questions, true);
  if (!questions.length) throw new CliError('UNSUPPORTED_INTERACTION', '当前提问没有有效问题');
  return bind(context, 'ASK_USER_MESSAGE', { questions, actions: ['SUBMIT'], schema: ANSWER_JSON_SCHEMA });
};
