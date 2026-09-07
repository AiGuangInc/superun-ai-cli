/** 继续项目创作。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { messageOptions, sendMessage } from './message.js';

export function registerSend(chat: Command, context: CommandContext): void {
  messageOptions(chat.command('send <sessionId>').description('继续项目创作')).action(
    async (sessionId: string, _options: unknown, command: Command) =>
      sendMessage(context, sessionId, command),
  );
}
