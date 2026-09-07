/** 对话创作。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { registerCreate } from './create.js';
import { registerSend } from './send.js';
import { registerState } from './state.js';
import { registerWait } from './wait.js';
import { registerStop } from './stop.js';
import { registerStyle } from './style.js';
import { registerInteraction } from './interaction.js';
import { registerPlugin } from './plugin.js';
import { registerPublish } from './publish.js';

export function registerChat(program: Command, context: CommandContext): void {
  const chat = program.command('chat').description('对话创作');
  registerCreate(chat, context);
  registerSend(chat, context);
  registerState(chat, context);
  registerWait(chat, context);
  registerStop(chat, context);
  registerStyle(chat, context);
  registerInteraction(chat, context);
  registerPlugin(chat, context);
  registerPublish(chat, context);
}
