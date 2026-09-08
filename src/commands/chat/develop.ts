/** 进入研发并等待规划或下一步交互。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { businessWrite, runtime, waitOptions, withWait } from '../shared.js';
import { object } from '../../contracts/value.js';

export function registerDevelop(chat: Command, context: CommandContext): void {
  withWait(chat.command('develop <sessionId>').description('保留演示，进入研发并生成规划')).action(
    async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const response = await businessWrite(context, service, sessionId, () =>
        service.startDevelopment(sessionId),
      );
      context.output.write(
        await service.accepted(
          object(response),
          sessionId,
          object(command.opts()).wait !== false,
          waitOptions(command),
        ),
      );
    },
  );
}
