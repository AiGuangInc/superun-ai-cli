/** 新建项目并发送需求。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { messageOptions, sendMessage } from './message.js';

export function registerCreate(chat: Command, context: CommandContext): void {
  messageOptions(chat.command('create').description('新建项目并发送需求'))
    .option('--model <model>', '选择模型')
    .option('--workspace-id <workspaceId>', '归属工作空间')
    .option('--skip-question', '跳过需求问卷，创建后立即生成方案')
    .option(
      '--advanced',
      '配合 --skip-question 委托高级设计师；先运行 free-quota，缺少设计师额度或查询失败时暂停，实际状态以服务端回执为准',
    )
    .action(async (_options: unknown, command: Command) => sendMessage(context, undefined, command));
}
