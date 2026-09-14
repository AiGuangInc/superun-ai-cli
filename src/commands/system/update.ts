/** 将本机 CLI 更新到 npm latest。@author xiuyu.yi */
import type { Command } from 'commander';
import type { OutputWriter } from '../../output/writer.js';
export function registerUpdate(
  program: Command,
  output: OutputWriter,
  update: () => Promise<{ version: string }>,
): void {
  program
    .command('update')
    .description('检查并将本机 CLI 更新到最新版本')
    .action(async () => {
      const result = await update();
      output.write({ state: 'COMPLETED', version: result.version });
    });
}
