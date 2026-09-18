/** 等待当前交互或任务结果。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime, positive, waitOptions } from '../shared.js';
import { CliError } from '../../output/exit-codes.js';

export function registerWait(chat: Command, context: CommandContext): void {
  chat
    .command('wait <sessionId>')
    .description('等待当前交互或任务结果，期间持续展示任务进度')
    .option('--message-id <messageId>', '起始消息 ID')
    .option('--review-id <reviewId>', '持续跟进指定安全扫描，直到报告生成')
    .option('--timeout <seconds>', '本地等待上限；不传则持续等待', positive)
    .option('--interval <seconds>', '轮询最小间隔', positive)
    .option('--progress-revision <revision>', '上次已展示的任务进度版本；仅输出变化的进度')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const options = waitOptions(command);
      if (options.reviewId && options.messageId)
        throw new CliError('INVALID_ARGUMENT', '扫描 ID 与消息 ID 不能同时指定');
      context.output.write(
        await (
          await runtime(context, command)
        ).wait(sessionId, {
          ...options,
          // no-wait 回执带的新消息也必须先入流，不能返回前一轮结果。
          requiredMessageId: options.reviewId ? undefined : options.messageId,
        }),
      );
    });
}
