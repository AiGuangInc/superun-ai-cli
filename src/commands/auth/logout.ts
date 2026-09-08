/** 清除本地 PAT。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';

export function registerLogout(auth: Command, context: CommandContext): void {
  auth
    .command('logout')
    .description('清除本地 PAT')
    .action(async () => {
      await context.patStore.clear();
      if (process.env.SUPERUN_PAT !== undefined)
        context.output.log('本地 PAT 已清除；SUPERUN_PAT 环境变量仍有效，请在终端执行 unset SUPERUN_PAT。');
      context.output.write({
        state: 'LOGGED_OUT',
        environmentCredentialPresent: process.env.SUPERUN_PAT !== undefined,
      });
    });
}
