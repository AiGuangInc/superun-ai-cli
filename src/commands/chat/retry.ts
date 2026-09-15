/** 充值后按 Glow 的精确消息 ID 重试原任务。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime, businessWrite, withWait, waitOptions } from '../shared.js';
import { object } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';
import { retryableMainMessage } from '../../conversation/insufficient-credits.js';

export function registerRetry(chat: Command, context: CommandContext): void {
  withWait(
    chat.command('retry <sessionId> <messageId>').description('充值或处理异常后重试原失败任务'),
  ).action(async (sessionId: string, messageId: string, _options: unknown, command: Command) => {
    const service = await runtime(context, command);
    const validate = async () => {
      if (retryableMainMessage(await service.load(sessionId)) !== messageId)
        throw new CliError('STALE_INTERACTION', '该消息已不是当前失败任务，请重新查询状态，不重复重试', {
          sessionId,
        });
    };
    const response = await businessWrite(context, service, sessionId, async () => {
      await validate();
      await service.command.checkBalance(sessionId);
      await validate();
      return service.command.retry(sessionId, messageId);
    });
    context.output.log('正在重试刚才的任务。');
    context.output.write(
      await service.accepted(
        object(response),
        sessionId,
        object(command.opts()).wait !== false,
        waitOptions(command),
      ),
    );
  });
}
