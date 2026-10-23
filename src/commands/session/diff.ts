/** 读取两个明确主线版本的实际差异。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime } from '../shared.js';
import { snapshotDiff } from '../../conversation/snapshot-diff.js';

export function registerDiff(session: Command, context: CommandContext): void {
  session
    .command('diff <sessionId> <oldReplyMessageId> <newReplyMessageId>')
    .description('对比本作品两个主线版本的文件变化，包含新侧当前账号暂存')
    .option('--include-diff', '附有限的代码差异片段，不返回完整源文件')
    .action(
      async (
        sessionId: string,
        oldId: string,
        newId: string,
        options: { includeDiff?: boolean },
        command: Command,
      ) => {
        context.output.write(
          await snapshotDiff(
            await runtime(context, command),
            sessionId,
            oldId,
            newId,
            options.includeDiff === true,
          ),
        );
      },
    );
}
