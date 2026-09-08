/** 查看已生成的演示并同步已查看状态。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { businessWrite, runtime } from '../shared.js';

export function registerDemo(chat: Command, context: CommandContext): void {
  chat
    .command('demo <sessionId>')
    .description('查看演示快照并记录已查看状态')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      context.output.write(
        await businessWrite(context, service, sessionId, () => service.viewDemo(sessionId)),
      );
    });
}
