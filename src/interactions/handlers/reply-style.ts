/** 风格交互与 chat style select 共用同一条调用链。@author xiuyu.yi */
import { requiredText } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';
import type { ReplyHandler } from './types.js';
export const replyStyle: ReplyHandler = ({ runtime, binding, input }) => {
  if (input.action !== 'SELECT') throw new CliError('INVALID_ARGUMENT', '风格交互仅支持选择候选');
  return runtime.selectStyle(binding.round.sessionId, requiredText(input.choiceId, 'choiceId'));
};
