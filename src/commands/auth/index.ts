/** 管理 PAT 登录。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { registerLogin } from './login.js';
import { registerStatus } from './status.js';
import { registerLogout } from './logout.js';

export function registerAuth(program: Command, context: CommandContext): void {
  const auth = program.command('auth').description('管理 PAT 登录');
  registerLogin(auth, context);
  registerStatus(auth, context);
  registerLogout(auth, context);
}
