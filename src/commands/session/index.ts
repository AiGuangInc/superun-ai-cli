/** 查询和管理项目。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { registerList } from './list.js';
import { registerGet } from './get.js';
import { registerStop } from './stop.js';

export function registerSession(program: Command, context: CommandContext): void {
  const session = program.command('session').description('查询和管理项目');
  registerList(session, context);
  registerGet(session, context);
  registerStop(session, context);
}
