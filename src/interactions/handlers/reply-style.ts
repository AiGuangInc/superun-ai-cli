/** 风格交互与 chat style select/retry 共用同一条调用链。@author xiuyu.yi */
import { requiredText } from '../../contracts/value.js';
import type { ReplyHandler } from './types.js';
export const replyStyle: ReplyHandler = ({ runtime, binding, input }) =>
  runtime.selectStyle(
    binding.round.sessionId,
    requiredText(input.choiceId, 'choiceId'),
    input.action === 'RETRY',
  );
