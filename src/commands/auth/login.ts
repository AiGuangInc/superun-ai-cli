/** 复用已有 PAT，缺失时通过网页登录领取；支持手动导入。@author xiuyu.yi */
import { Option } from 'commander';
import type { Command } from 'commander';
import { readPatFromStdin } from '../../auth/pat-store.js';
import type { CommandContext } from '../shared.js';
import { requireCredentials } from '../shared.js';

export function registerLogin(auth: Command, context: CommandContext): void {
  auth
    .command('login')
    .description('登录 Superun 并保存 PAT')
    .addOption(new Option('--pat', '在终端隐藏输入现有 PAT').conflicts('stdin'))
    .option('--stdin', '从标准输入读取 PAT')
    .action(async (options: { pat?: boolean; stdin?: boolean }, command: Command) => {
      if (!options.pat && !options.stdin) {
        const { credentialSource } = await requireCredentials(context, command, true);
        context.output.write({ state: 'CONFIGURED', credentialSource });
        return;
      }
      const pat = await readPatFromStdin(!options.stdin);
      context.output.registerSecret(pat);
      await context.patStore.save(pat);
      context.output.write({ state: 'CONFIGURED', credentialSource: 'file' });
    });
}
