/** 提交用户对数据库变更的确认。@author xiuyu.yi */
import { requiredText } from '../../contracts/value.js';
import type { ReplyHandler } from './types.js';
export const replyDdl: ReplyHandler = ({ runtime, binding }) =>
  runtime.command.replySingle({
    sessionId: binding.round.sessionId,
    toolId: requiredText(binding.interaction.source.toolId, 'toolId'),
    content: '已确认执行数据库变更',
  });
