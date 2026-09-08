/** 命令树与公共选项。@author xiuyu.yi */
import { Command, Option } from 'commander';
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
    .description('superun-ai 项目管理、对话创作和应用发布')
    .version(PACKAGE_VERSION)
    .addOption(new Option('--env <environment>', '目标环境，默认 prod').choices(['prod', 'pre']))
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
