/** 查询当前登录用户的工作空间。@author xiuyu.yi */
import type { Command } from 'commander';
import { listWorkspaces, workspaceSummary } from '../api/account-query-api.js';
import { runtime, type CommandContext } from './shared.js';

export function registerWorkspace(program: Command, context: CommandContext): void {
  program
    .command('workspace')
    .description('查询工作空间')
    .command('list')
    .description('列出本人所属团队及角色')
    .action(async (_options, command: Command) => {
      const service = await runtime(context, command);
      context.output.write({
        state: 'COMPLETED',
        items: (await listWorkspaces(service.client)).map(workspaceSummary),
      });
    });
}
