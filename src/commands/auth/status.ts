/** 默认查看本地配置，可显式在线核对已有 PAT。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { requireCredentials } from '../shared.js';
import { verifyCredential } from '../../auth/credential-status.js';

export function registerStatus(auth: Command, context: CommandContext): void {
  auth
    .command('status')
    .description('查看本地 PAT 配置状态')
    .option('--online', '只读验证当前 PAT 是否仍有效，不打开浏览器')
    .action(async (options: { online?: boolean }, command: Command) => {
      const { credentialSource, service } = await requireCredentials(context, command);
      if (options.online) await verifyCredential(service.client);
      context.output.write({
        state: 'CONFIGURED',
        credentialSource,
        ...(options.online ? { authenticated: true, checkedOnline: true } : {}),
      });
    });
}
