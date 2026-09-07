/** 停止远端任务。@author xiuyu.yi */
import type { Command } from 'commander';
import { Option } from 'commander';
import { object, text } from '../../contracts/value.js';
import type { CommandContext } from '../shared.js';
import { runtime, businessWrite } from '../shared.js';

export function registerStop(session: Command, context: CommandContext): void {
  session
    .command('stop <sessionId>')
    .description('停止远端任务')
    .option('--message-id <messageId>', '指定任务消息')
    .addOption(new Option('--scope <scope>', '停止范围').choices(['own', 'all']).default('own'))
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        options = object(command.opts());
      await businessWrite(context, service, sessionId, () =>
        service.command.stop(sessionId, options.scope === 'all' ? 'all' : 'own', text(options.messageId)),
      );
      context.output.write({ state: 'CANCELLED', sessionId });
    });
}
