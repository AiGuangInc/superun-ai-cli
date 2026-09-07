/** 查询项目。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { registerList } from './list.js';
import { registerGet } from './get.js';

export function registerSession(program: Command, context: CommandContext): void {
  const session = program.command('session').description('查询项目');
  registerList(session, context);
  registerGet(session, context);
}
