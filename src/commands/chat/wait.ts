/** 等待当前交互或任务结果。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime, positive, waitOptions } from '../shared.js';

export function registerWait(chat: Command, context: CommandContext): void {
  chat
    .command('wait <sessionId>')
    .description('等待当前交互或任务结果')
    .option('--message-id <messageId>', '起始消息 ID')
    .option('--timeout <seconds>', '本地等待上限', positive, 1800)
    .option('--interval <seconds>', '轮询最小间隔', positive)
    .action(async (sessionId: string, _options: unknown, command: Command) =>
      context.output.write(
        await (await runtime(context, command)).waiter.wait(sessionId, waitOptions(command)),
      ),
    );
}
