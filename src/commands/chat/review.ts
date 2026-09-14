/** 审查已有项目代码并自动修复确认的问题。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { messageOptions, sendMessage } from './message.js';

export function registerReview(chat: Command, context: CommandContext): void {
  messageOptions(
    chat
      .command('review <sessionId>')
      .description('代码审查，告知发现的问题后自动修复；默认审查刚才改动的代码'),
  ).action(async (sessionId: string, _options: unknown, command: Command) =>
    sendMessage(context, sessionId, command, 'review'),
  );
}
