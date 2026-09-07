/** DDL 仅在服务端未自动同意时要求用户确认。@author xiuyu.yi */
import { bind, pendingTool, toolId } from '../context.js';
import type { InteractionParser } from '../context.js';
import { visibleText } from '../../conversation/text-projector.js';

export const parseDdl: InteractionParser = (context) => {
  if (!pendingTool(context.item) || !toolId(context.item) || context.item.payload.autoApprove === true)
    return undefined;
  return bind(context, 'DDL_CONFIRMATION', {
    actions: ['APPROVE'],
    details: { summary: visibleText(context.item.payload) },
  });
};
