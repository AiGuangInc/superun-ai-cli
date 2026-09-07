/** 查询项目详情。@author xiuyu.yi */
import type { Command } from 'commander';
import { object } from '../../contracts/value.js';
import type { CommandContext } from '../shared.js';
import { runtime } from '../shared.js';

export function registerGet(session: Command, context: CommandContext): void {
  session
    .command('get <sessionId>')
    .description('查询项目详情')
    .option('--include-attachments', '包含可见附件清单')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        result = await service.state(sessionId);
      if (object(command.opts()).includeAttachments)
        result.attachments = await service.query.attachments(sessionId);
      context.output.write(result);
    });
}
