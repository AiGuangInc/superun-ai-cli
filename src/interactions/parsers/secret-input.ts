/** Secret 卡片只输出键名与说明。@author xiuyu.yi */
import { list, object, text } from '../../contracts/value.js';
import { bind, pendingTool, toolData, toolId } from '../context.js';
import type { InteractionParser } from '../context.js';

export const parseSecret: InteractionParser = (context) => {
  if (!pendingTool(context.item) || !toolId(context.item)) return undefined;
  const data = toolData(context.item);
  const keys = [...list(data.envs), ...list(data.secretKeys)]
    .map((item) => {
      const value = object(item),
        name = text(value.name);
      return (
        text(item) ??
        text(value.key) ??
        (name ? `${text(value.prefix) ? `${String(value.prefix)}_` : ''}${name}` : undefined)
      );
    })
    .filter((key): key is string => !!key);
  return bind(
    context,
    context.item.variant === 'tool_plugin_secrets_create' ? 'PLUGIN_SECRET_INPUT' : 'SECRET_INPUT',
    {
      actions: ['SUBMIT', 'SKIP'],
      details: { keys: [...new Set(keys)], pluginName: text(data.pluginName) },
      schema: {
        type: 'object',
        properties: { values: { type: 'object', additionalProperties: { type: 'string' } } },
        required: ['values'],
        additionalProperties: false,
      },
    },
  );
};
