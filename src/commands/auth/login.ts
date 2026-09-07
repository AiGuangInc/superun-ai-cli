/** 接收并保存 PAT，不额外请求业务接口。@author xiuyu.yi */
import { Option } from 'commander';
import type { Command } from 'commander';
import { readPatFromStdin, validatePat } from '../../auth/pat-store.js';
import type { CommandContext } from '../shared.js';

export function registerLogin(auth: Command, context: CommandContext): void {
  auth
    .command('login')
    .description('配置本地 PAT')
    .addOption(new Option('--pat', '在终端隐藏输入现有 PAT').conflicts('stdin'))
    .option('--stdin', '从标准输入读取 PAT')
    .action(async (options: { pat?: boolean; stdin?: boolean }) => {
      const useEnv = !options.pat && !options.stdin && process.env.SUPERUN_PAT !== undefined;
      const pat = useEnv
        ? validatePat(process.env.SUPERUN_PAT ?? '')
        : await readPatFromStdin(!options.stdin);
      context.output.registerSecret(pat);
      if (!useEnv) await context.patStore.save(pat);
      context.output.write({ state: 'CONFIGURED', credentialSource: useEnv ? 'env' : 'file' });
    });
}
