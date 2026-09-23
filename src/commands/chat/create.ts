/** 新建项目并发送需求。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { messageOptions, sendMessage } from './message.js';

export function registerCreate(chat: Command, context: CommandContext): void {
  messageOptions(chat.command('create').description('新建项目并发送需求'))
    .option('--model <model>', '选择模型')
    .option('--workspace-id <workspaceId>', '归属工作空间')
    .option('--skip-question', '跳过需求问卷，创建后立即生成方案')
    .option('--advanced', '配合 --skip-question 委托高级设计师生成方案；可能消耗 50～100 算力值')
    .action(async (_options: unknown, command: Command) => sendMessage(context, undefined, command));
}
