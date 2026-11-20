/** 管理 PAT 登录。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { readAccountOverview } from '../../api/account-overview.js';
import { readContacts } from '../../api/account-query-api.js';
import { runtime } from '../shared.js';
import { registerLogin } from './login.js';
import { registerStatus } from './status.js';
import { registerLogout } from './logout.js';

export function registerAuth(program: Command, context: CommandContext): void {
  const auth = program.command('auth').description('管理 PAT 登录');
  registerLogin(auth, context);
  registerStatus(auth, context);
  auth
    .command('whoami')
    .description('查询当前用户、个人算力余额、本人管理的团队及其余额')
    .action(async (_options, command: Command) => {
      const service = await runtime(context, command);
      context.output.write(await readAccountOverview(service.client));
    });
  auth
    .command('contacts')
    .description('查询绑定邮箱与脱敏手机号')
    .action(async (_options, command: Command) => {
      const service = await runtime(context, command);
      context.output.write(await readContacts(service.client));
    });
  registerLogout(auth, context);
}
