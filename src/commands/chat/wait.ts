/** 等待当前交互或任务结果。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime, positive, waitOptions } from '../shared.js';

export function registerWait(chat: Command, context: CommandContext): void {
  chat
    .command('wait <sessionId>')
    .description('等待当前交互或任务结果，期间持续展示任务进度')
    .option('--message-id <messageId>', '起始消息 ID')
    .option('--timeout <seconds>', '本地等待上限；不传则持续等待', positive)
    .option('--interval <seconds>', '轮询最小间隔', positive)
    .option('--progress-revision <revision>', '上次已展示的任务进度版本；仅输出变化的进度')
    .action(async (sessionId: string, _options: unknown, command: Command) =>
      context.output.write(await (await runtime(context, command)).wait(sessionId, waitOptions(command))),
    );
}
