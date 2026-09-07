/** 安装当前发布渠道指定的版本。@author xiuyu.yi */
import type { Command } from 'commander';
import type { OutputWriter } from '../../output/writer.js';
export function registerUpdate(
  program: Command,
  output: OutputWriter,
  update: () => Promise<{ version: string }>,
): void {
  program
    .command('update')
    .description('检查并安装指定版本')
    .action(async () => {
      const result = await update();
      output.write({ state: 'COMPLETED', version: result.version });
    });
}
