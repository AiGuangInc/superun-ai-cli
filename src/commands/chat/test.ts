/** 验证已有项目功能并自动修复确认的问题。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { messageOptions, sendMessage } from './message.js';

export function registerTest(chat: Command, context: CommandContext): void {
  messageOptions(
    chat
      .command('test <sessionId>')
      .description('自动测试指定功能，告知发现的问题后自动修复；默认测试刚才完成的功能'),
  ).action(async (sessionId: string, _options: unknown, command: Command) =>
    sendMessage(context, sessionId, command, true),
  );
}
