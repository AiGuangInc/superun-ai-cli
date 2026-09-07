/** 需求澄清卡片。@author xiuyu.yi */
import { object } from '../../contracts/value.js';
import { bind, toolData } from '../context.js';
import type { InteractionParser } from '../context.js';
import { ANSWER_JSON_SCHEMA, projectQuestions } from '../questions.js';

export const parsePrd: InteractionParser = (context) => {
  if (!context.current || object(context.item.payload.extra).submitPrdQuestions) return undefined;
  if (context.round.status !== 'completed') return undefined;
  const questions = projectQuestions(object(toolData(context.item).toolParams).questions).map((question) => ({
    ...question,
    multiSelect: true,
  }));
  return bind(context, 'PRD_CLARIFICATION', {
    questions,
    actions: ['REFINE', 'GENERATE_STYLES'],
    schema: ANSWER_JSON_SCHEMA,
  });
};
