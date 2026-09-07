/** 清除本地 PAT。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';

export function registerLogout(auth: Command, context: CommandContext): void {
  auth
    .command('logout')
    .description('清除本地 PAT')
    .action(async () => {
      await context.patStore.clear();
      context.output.write({
        state: 'LOGGED_OUT',
        environmentCredentialPresent: process.env.SUPERUN_PAT !== undefined,
      });
    });
}
