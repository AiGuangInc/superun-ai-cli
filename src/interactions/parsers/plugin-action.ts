/** 插件操作提示保留业务字段，连接密钥不返回。@author xiuyu.yi */
import { text } from '../../contracts/value.js';
import { bind, pendingTool, toolData, toolId } from '../context.js';
import type { InteractionParser } from '../context.js';

export const parsePlugin: InteractionParser = (context) => {
  if (!pendingTool(context.item) || !toolId(context.item)) return undefined;
  const data = toolData(context.item);
  return bind(context, 'PLUGIN_ACTION', {
    actions: ['ENABLE', 'SKIP'],
    details: { pluginName: text(data.pluginName), mode: text(data.mode), statusText: text(data.statusText) },
    schema: {
      type: 'object',
      properties: { action: { enum: ['ENABLE', 'SKIP'] }, config: { type: 'object' } },
      required: ['action'],
      additionalProperties: false,
    },
  });
};
