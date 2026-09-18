/** 查询项目。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { registerList } from './list.js';
import { registerGet } from './get.js';
import { runtime, sessionBinding } from '../shared.js';
import { CliError } from '../../output/exit-codes.js';

export function registerSession(program: Command, context: CommandContext): void {
  const session = program.command('session').description('查询项目与当前会话绑定');
  registerList(session, context);
  registerGet(session, context);
  session
    .command('current')
    .description('读取当前宿主会话保存的项目绑定')
    .action(async (_options, command) => {
      const binding = await sessionBinding(context, await runtime(context, command));
      context.output.write(
        binding
          ? await binding.current()
          : {
              state: 'UNAVAILABLE',
              reason: '宿主未提供可确认归属的会话身份，请继续显式传入 sessionId。',
            },
      );
    });
  session
    .command('use <sessionId>')
    .description('选择当前会话继续使用的项目')
    .action(async (sessionId: string, _options, command) => {
      const service = await runtime(context, command);
      const binding = await sessionBinding(context, service);
      if (!binding)
        throw new CliError('INVALID_ARGUMENT', '宿主未提供可确认归属的会话身份，无法保存项目绑定');
      await binding.select(service, sessionId);
      context.output.write(await binding.current());
    });
  session
    .command('clear')
    .description('清除当前会话的项目绑定，保留远端项目')
    .action(async (_options, command) => {
      const binding = await sessionBinding(context, await runtime(context, command));
      if (!binding)
        throw new CliError('INVALID_ARGUMENT', '宿主未提供可确认归属的会话身份，无法清除项目绑定');
      await binding.clear();
      context.output.write(await binding.current());
    });
}
