/** 查询当前任务和交互。@author xiuyu.yi */
import type { Command } from 'commander';
import { z } from 'zod';
import { object, text } from '../../contracts/value.js';
import { applySnapshot } from '../../conversation/session-waiter.js';
import type { CommandContext } from '../shared.js';
import { runtime } from '../shared.js';
import { appendValue } from './message.js';
import { CliError } from '../../output/exit-codes.js';

export function registerState(chat: Command, context: CommandContext): void {
  chat
    .command('state <sessionId>')
    .description('查询当前任务和交互')
    .option('--message-id <messageId>', '刷新指定消息快照')
    .option('--review-id <reviewId>', '查询指定的本次安全扫描及报告')
    .option('--progress-revision <revision>', '上次已展示的任务进度版本')
    .option('--include-file <name>', '包含指定可见附件正文，可重复使用', appendValue, [])
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        options = object(command.opts());
      if (options.reviewId && options.messageId)
        throw new CliError('INVALID_ARGUMENT', '扫描 ID 与消息 ID 不能同时指定');
      let view = await service.load(sessionId);
      if (typeof options.messageId === 'string') {
        const snapshot = await service.conversation.snapshot(sessionId, options.messageId);
        if (snapshot.pipeline) view = applySnapshot(view, snapshot.pipeline);
      }
      const result = await service.inspect(view, undefined, text(options.reviewId)),
        names = z.array(z.string()).parse(options.includeFile);
      if (result.taskProgress)
        result.taskProgress.changed = result.taskProgress.revision !== options.progressRevision;
      if (names.length) result.attachments = await service.query.attachments(sessionId, names);
      context.output.write(service.withGuidance(result));
    });
}
