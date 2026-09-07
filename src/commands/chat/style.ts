/** 创作流程中的风格生成、选择与重试。@author xiuyu.yi */
import type { Command } from 'commander';
import { object, requiredText, text } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';
import type { CommandContext } from '../shared.js';
import { runtime, positive, withWait, waitOptions, businessWrite } from '../shared.js';

export function registerStyle(chat: Command, context: CommandContext): void {
  const style = chat.command('style').description('管理创作风格');
  withWait(
    style
      .command('generate <sessionId>')
      .description('生成风格候选')
      .requiredOption('--content <text>', '风格需求')
      .option('--count <count>', '候选数量，1～4', positive, 2),
  ).action(async (sessionId: string, _options: unknown, command: Command) => {
    const service = await runtime(context, command),
      options = object(command.opts());
    const count = Number(options.count);
    if (count > 4) throw new CliError('INVALID_ARGUMENT', '最多生成 4 个风格');
    const response = await businessWrite(context, service, sessionId, () =>
      service.generateStyles(sessionId, requiredText(options.content, 'content'), count),
    );
    context.output.write(
      await service.accepted(object(response), sessionId, options.wait !== false, waitOptions(command)),
    );
  });
  style
    .command('list <sessionId>')
    .description('查询全部风格批次')
    .option('--anchor <preReplyMessageId>', '分支查询锚点')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        choices = await service.choices(sessionId, text(object(command.opts()).anchor));
      context.output.write({ state: 'COMPLETED', sessionId, choices });
    });
  for (const action of ['select', 'retry'])
    withWait(
      style
        .command(`${action} <sessionId> <choiceId>`)
        .description(action === 'select' ? '选择已完成的风格' : '重试失败风格'),
    ).action(async (sessionId: string, choiceId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const response = await businessWrite(context, service, sessionId, () =>
        service.selectStyle(sessionId, choiceId, action === 'retry'),
      );
      context.output.write(
        await service.accepted(
          object(response),
          sessionId,
          object(command.opts()).wait !== false,
          waitOptions(command),
        ),
      );
    });
}
