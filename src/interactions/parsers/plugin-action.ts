/** 插件操作提示保留业务字段，连接密钥不返回。@author xiuyu.yi */
import { enabled, list, object, text } from '../../contracts/value.js';
import { bind, pendingTool, toolData, toolId } from '../context.js';
import type { InteractionParser } from '../context.js';

export const parsePlugin: InteractionParser = (context) => {
  if (!pendingTool(context.item) || !toolId(context.item)) return undefined;
  if (enabled(object(context.item.payload.extra).AUTO_APPROVE)) return undefined;
  const data = toolData(context.item);
  if (
    ['CUSTOM_MINIPROGRAM', 'Miniprogram', 'MINIPROGRAM', 'WeChat Miniprogram', 'WechatMiniprogram'].includes(
      String(data.pluginName),
    )
  )
    return bind(context, 'UNSUPPORTED', {
      actions: [],
      details: {
        pluginName: text(data.pluginName),
        notice:
          '小程序的业务配置请在 superun 网页完成；基础插件启动、停用和恢复可使用 chat plugin 命令，启用不代表业务配置完成。',
      },
    });
  if (data.toolName && !['PluginEnable', 'PluginConfigurationModify'].includes(String(data.toolName)))
    return bind(context, 'UNSUPPORTED', {
      actions: [],
      details: {
        pluginName: text(data.pluginName),
        toolName: text(data.toolName),
        notice: '此插件操作需在 superun 网页处理，CLI 不会将它当作启用提交。',
      },
    });
  const configuring = data.toolName === 'PluginConfigurationModify';
  const actions = configuring ? ['CONFIRM', 'SKIP'] : ['ENABLE', 'SKIP'];
  return bind(context, 'PLUGIN_ACTION', {
    actions,
    details: {
      pluginName: text(data.pluginName),
      toolName: text(data.toolName),
      mode: text(data.mode),
      statusText: text(data.statusText),
      requiredPermissions: list(object(data.requiredPermissions).permissions).map((item) => {
        const value = object(item);
        return { scope: text(value.scope), name: text(value.name), type: text(value.type) };
      }),
      securitySettings: list(object(data.securitySettings).settings).map((item) => {
        const value = object(item);
        return { type: text(value.type), name: text(value.name), description: text(value.description) };
      }),
      path: text(data.path),
      ...(configuring
        ? {
            notice: '请到 superun 网页当前项目的插件面板修改配置，完成后再确认；也可以跳过。',
            instruction:
              '这是配置修改，不是启用。引导用户打开网页插件设置，只有用户明确表示已完成配置才提交 CONFIRM；不能自动启用或声称已经打开网页。',
          }
        : {}),
    },
    schema: {
      type: 'object',
      properties: { action: { enum: actions }, ...(!configuring ? { config: { type: 'object' } } : {}) },
      required: ['action'],
      additionalProperties: false,
    },
  });
};
