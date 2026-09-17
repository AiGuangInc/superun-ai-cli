/** 启用插件并在未被托管时提交工具结果。@author xiuyu.yi */
import { setTimeout as delay } from 'node:timers/promises';
import { object, requiredText, text } from '../../contracts/value.js';
import { toolData } from '../context.js';
import { CliError } from '../../output/exit-codes.js';
import type { ReplyHandler } from './types.js';

const ALIASES: Record<string, Array<string>> = {
  SUPABASE_EMBED: ['SuperunCloud', 'Superun', 'SUPERUN_CLOUD'],
  SUPERUN_AI: ['SuperunAI'],
  STRIPE: ['Stripe'],
  NANO_BANANA: ['NanoBanana'],
  DINGTALK: ['DingTalk'],
  FEISHU: ['Feishu', 'FeiShu', 'Lark', 'feishu', 'lark'],
  WECOM: ['WeCom'],
  CUSTOM_MINIPROGRAM: ['Miniprogram', 'MINIPROGRAM', 'WeChat Miniprogram', 'WechatMiniprogram'],
};
export function integrationKey(name: string): string {
  const normalized = name.trim().toUpperCase();
  return (
    Object.entries(ALIASES).find(
      ([key, aliases]) => key === normalized || aliases.some((alias) => alias.toUpperCase() === normalized),
    )?.[0] ?? normalized
  );
}
export const replyPlugin: ReplyHandler = async ({ runtime, binding, input }) => {
  const sessionId = binding.round.sessionId,
    toolId = requiredText(binding.interaction.source.toolId, 'toolId');
  if (input.action === 'SKIP')
    return runtime.command.replySingle({
      sessionId,
      toolId,
      toolResult: JSON.stringify({ enabled: false, skipped: true, statusText: '用户已跳过插件配置' }),
    });
  const plugin = integrationKey(requiredText(toolData(binding.item).pluginName, 'pluginName'));
  if (input.action === 'CONFIRM') {
    if (input.config !== undefined || toolData(binding.item).toolName !== 'PluginConfigurationModify')
      throw new CliError('INVALID_ARGUMENT', '当前操作只用于确认已在网页完成配置');
    const state = await runtime.integration.status(sessionId, plugin);
    return runtime.command.replySingle({
      sessionId,
      toolId,
      toolResult: JSON.stringify({
        enabled: state.integrationStatus === 'ENABLED',
        statusText: '用户确认已在 superun 网页处理插件配置',
      }),
    });
  }
  if (
    input.config !== undefined &&
    (!input.config || typeof input.config !== 'object' || Array.isArray(input.config))
  )
    throw new CliError('INVALID_ARGUMENT', 'config 必须是配置对象');
  const config = object(input.config);
  for (const value of Object.values(config))
    if (typeof value === 'string') {
      runtime.output.registerSecret(value);
      runtime.output.registerSecret(value.trim());
    }
  let result = await runtime.integration.connect(
    sessionId,
    plugin,
    config,
    toolId,
    object(toolData(binding.item).pluginConfig),
  );
  if (result.toolCallOwned === true) return { sessionId };
  const deadline = Date.now() + 1800_000;
  while (['ENABLING', 'RESTORING', 'PAUSING', 'DISABLING'].includes(String(result.integrationStatus))) {
    if (Date.now() >= deadline)
      throw new CliError('LOCAL_WAIT_TIMEOUT', '插件仍在处理中，请查询会话状态后继续', { sessionId });
    try {
      await delay(2000, undefined, { signal: runtime.client.signal });
    } catch {
      throw new CliError('INTERRUPTED', '已停止等待插件，远端任务继续运行', { sessionId });
    }
    result = await runtime.integration.status(sessionId, plugin);
    if (result.toolCallOwned === true) return { sessionId };
  }
  if (!['ENABLED', 'NOT_ENABLED', 'DISABLED', 'PAUSED'].includes(String(result.integrationStatus)))
    throw new CliError('OUTCOME_UNKNOWN', '插件状态尚未确认，请查询当前状态，不重复启用或回填失败', {
      sessionId,
      pluginId: plugin,
    });
  return runtime.command.replySingle({
    sessionId,
    toolId,
    toolResult: JSON.stringify({
      enabled: result.integrationStatus === 'ENABLED',
      statusText: text(result.integrationStatus) ?? 'UNKNOWN',
    }),
  });
};
