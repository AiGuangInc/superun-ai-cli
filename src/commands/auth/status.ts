/** 查看本地 PAT 配置状态，不额外请求业务接口。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { requireCredentials } from '../shared.js';

export function registerStatus(auth: Command, context: CommandContext): void {
  auth
    .command('status')
    .description('查看本地 PAT 配置状态')
    .action(async (_options: unknown, command: Command) => {
      const { credentialSource } = await requireCredentials(context, command);
      context.output.write({
        state: 'CONFIGURED',
        credentialSource,
      });
    });
}
