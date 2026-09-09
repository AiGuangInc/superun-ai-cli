/** 创作流程中的风格生成、查询与选择。@author xiuyu.yi */
import type { Command } from 'commander';
import { object, requiredText, text } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';
import type { CommandContext } from '../shared.js';
import { runtime, positive, withWait, waitOptions, businessWrite } from '../shared.js';
import {
  latestStyleChoices,
  styleBatchState,
  styleBranchAnchor,
} from '../../interactions/parsers/style-selection.js';

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
        view = await service.load(sessionId),
        currentAnchor = styleBranchAnchor(view),
        anchor = text(object(command.opts()).anchor) ?? currentAnchor,
        choices = await service.choices(sessionId, anchor, view);
      const result = service.withGuidance({
        state: choices.length ? styleBatchState(latestStyleChoices(choices)) : 'COMPLETED',
        sessionId,
        choices,
        cursor: { branchAnchor: anchor },
      });
      context.output.write({
        state: result.state,
        sessionId,
        choices,
        // 历史批次只供查看；选择命令仅接受当前未决批次。
        nextActions: anchor === currentAnchor ? result.nextActions : [],
      });
    });
  withWait(style.command('select <sessionId> <choiceId>').description('选择风格并自动生成研发规划')).action(
    async (sessionId: string, choiceId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const response = await businessWrite(context, service, sessionId, () =>
        service.selectStyle(sessionId, choiceId),
      );
      context.output.write(
        await service.accepted(
          object(response),
          sessionId,
          object(command.opts()).wait !== false,
          waitOptions(command),
        ),
      );
    },
  );
}
