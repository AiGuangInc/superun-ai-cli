/** 继续项目创作。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { messageOptions, sendMessage } from './message.js';

export function registerSend(chat: Command, context: CommandContext): void {
  messageOptions(chat.command('send <sessionId>').description('继续项目创作'))
    .option(
      '--test-followup <messageId>',
      '回复当前自动测试报告，保留修复结果引导；使用结果中的 sourceMessageId',
    )
    .action(async (sessionId: string, _options: unknown, command: Command) =>
      sendMessage(context, sessionId, command),
    );
}
