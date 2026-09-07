/** Secret 只发送输入值，不回显、不保存到 CLI。@author xiuyu.yi */
import { object, list, requiredText } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';
import type { ReplyHandler } from './types.js';
export const replySecret: ReplyHandler = async ({ runtime, binding, input }) => {
  const sessionId = binding.round.sessionId,
    toolId = requiredText(binding.interaction.source.toolId, 'toolId');
  if (input.action === 'SKIP')
    return runtime.command.replySingle({
      sessionId,
      toolId,
      toolResult: JSON.stringify({ enabled: false, skipped: true, statusText: '用户已跳过配置' }),
    });
  const values = object(input.values),
    allowed = new Set(list(binding.interaction.details?.keys));
  if (!Object.keys(values).length) throw new CliError('INVALID_ARGUMENT', 'values 不能为空');
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key) || typeof value !== 'string')
      throw new CliError('INVALID_ARGUMENT', 'Secret 键名必须来自当前提问，值必须为字符串');
    runtime.output.registerSecret(value);
  }
  return runtime.conversation.replySecret({
    sessionId,
    toolId,
    extraParam: JSON.stringify(values),
    content: '已确认密钥配置',
  });
};
