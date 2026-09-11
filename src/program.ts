/** 命令树与公共选项。@author xiuyu.yi */
import { Command } from 'commander';
import { COMMAND_NAME, PACKAGE_VERSION } from './config/constants.js';
import type { CommandContext } from './commands/shared.js';
import { requireCredentials } from './commands/shared.js';
import { registerAuth } from './commands/auth/index.js';
import { registerSession } from './commands/session/index.js';
import { registerChat } from './commands/chat/index.js';
import { registerUpdate } from './commands/system/update.js';
import { registerVersion } from './commands/system/version.js';

export function createProgram(
  context: CommandContext,
  hooks: {
    beforeBusiness: () => Promise<void>;
    update: () => Promise<{ version: string }>;
  },
): Command {
  const program = new Command()
    .name(COMMAND_NAME)
    .description(
      '通过需求梳理、架构设计与开发协作，将网站和应用的想法转化为可持续迭代、可部署运维的生产级系统。',
    )
    .version(PACKAGE_VERSION)
    .option('--endpoint <URL>', 'API 地址')
    .option('--locale <language>', '回复语言', 'zh-CN')
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });
  program.hook('preAction', async (_root, action) => {
    context.connection = undefined;
    const rootCommand = action.parent === program;
    const authCommand = action.parent?.name() === 'auth' && action.parent.parent === program;
    const offline =
      (rootCommand && (action.name() === 'version' || action.name() === 'update')) ||
      (authCommand && action.name() === 'logout');
    if (offline || action === program) return;
    await hooks.beforeBusiness();
    if (!(authCommand && action.name() === 'login'))
      await requireCredentials(context, action, !authCommand && Boolean(process.stdin.isTTY));
  });
  registerAuth(program, context);
  registerSession(program, context);
  registerChat(program, context);
  registerUpdate(program, context.output, hooks.update);
  registerVersion(program, context.output);
  program.action(() => program.help());
  return program;
}
