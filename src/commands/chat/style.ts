/** 创作流程中的风格生成、查询与选择。@author xiuyu.yi */
import type { Command } from 'commander';
import { object, requiredText, text } from '../../contracts/value.js';
import type { CommandContext } from '../shared.js';
import { runtime, withWait, waitOptions, businessWrite } from '../shared.js';
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
      .requiredOption('--content <text>', '风格需求'),
  ).action(async (sessionId: string, _options: unknown, command: Command) => {
    const service = await runtime(context, command),
      options = object(command.opts());
    const response = await businessWrite(context, service, sessionId, () =>
      service.generateStyles(sessionId, requiredText(options.content, 'content')),
    );
    context.output.write(
      await service.accepted(object(response), sessionId, options.wait !== false, waitOptions(command)),
    );
  });
  style
    .command('list <sessionId>')
    .description('查询全部风格批次')
    .option('--anchor <preReplyMessageId>', '分支查询锚点')
    .option('--progress-revision <revision>', '上次已展示的任务进度版本')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        view = await service.load(sessionId),
        currentAnchor = styleBranchAnchor(view),
        anchor = text(object(command.opts()).anchor) ?? currentAnchor,
        choices = await service.choices(sessionId, anchor, view);
      const taskProgress = await service.taskProgress.read(view, choices);
      taskProgress.changed = taskProgress.revision !== object(command.opts()).progressRevision;
      const result = service.withGuidance({
        state: choices.length
          ? styleBatchState(choices)
          : anchor && view.session.pendingBranch?.preReplyMessageId === anchor
            ? 'RUNNING'
            : 'COMPLETED',
        sessionId,
        choices,
        styleGeneration: {
          choiceIds: latestStyleChoices(choices).map((choice) => choice.choiceId),
          phase: choices.some((choice) => choice.index > 0) ? 'append' : 'initial',
        },
        taskProgress,
        cursor: { branchAnchor: anchor },
      });
      context.output.write({
        state: result.state,
        styleGeneration: result.styleGeneration,
        sessionId,
        choices,
        taskProgress,
        cursor: result.cursor,
        // 历史批次只供查看；选择命令仅接受当前未决批次。
        nextActions: anchor === currentAnchor ? result.nextActions : [],
      });
    });
  withWait(
    style
      .command('append <sessionId>')
      .description('委托高级设计师再设计一版方案，每版预计消耗 50～100 算力值，按实际用量扣费')
      .requiredOption('--anchor <preReplyMessageId>', '当前风格轮次，使用查询结果中的 branchAnchor'),
  ).action(async (sessionId: string, _options: unknown, command: Command) => {
    const options = object(command.opts());
    const service = await runtime(context, command);
    const response = await businessWrite(context, service, sessionId, () =>
      service.appendStyle(sessionId, requiredText(options.anchor, 'anchor')),
    );
    context.output.write(
      await service.accepted(object(response), sessionId, options.wait !== false, waitOptions(command)),
    );
  });
  withWait(style.command('retry <sessionId> <choiceId>').description('重试失败的原方案任务')).action(
    async (sessionId: string, choiceId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const response = await businessWrite(context, service, sessionId, () =>
        service.retryStyle(sessionId, choiceId),
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
  withWait(style.command('select <sessionId> <choiceId>').description('选择风格并展示开发功能清单')).action(
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
