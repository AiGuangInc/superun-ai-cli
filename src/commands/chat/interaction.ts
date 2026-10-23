/** 提交当前交互的回答。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime, readInput, withWait, waitOptions, businessWrite } from '../shared.js';
import { object, requiredText } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';

export function registerInteraction(chat: Command, context: CommandContext): void {
  const interaction = chat.command('interaction').description('回答或跳过交互');
  for (const action of ['reply', 'skip']) {
    const command = withWait(
      interaction
        .command(`${action} <sessionId> <interactionId>`)
        .description(action === 'reply' ? '提交回答' : '跳过当前交互'),
      '本次回答处理结束后，不继续等待后续创作',
    );
    if (action === 'reply')
      command
        .requiredOption('--input <file>', '回答 JSON 文件，- 表示标准输入')
        .option('--agent-create-only', '智能体搭建专属模式：只创建配置，不开发后台或运行智能体');
    command.action(async (sessionId: string, interactionId: string, _options: unknown, current: Command) => {
      const options = object(current.opts()),
        service = await runtime(context, current);
      const input =
        action === 'skip' ? { action: 'SKIP' } : await readInput(requiredText(options.input, 'input'));
      const response = await businessWrite(context, service, sessionId, () =>
        service.reply(sessionId, interactionId, input, options.agentCreateOnly === true),
      );
      const creation = object(object(response).managedAgentCreation);
      const created =
        creation.createOnly === true &&
        creation.resourceSessionId === sessionId &&
        typeof creation.agentId === 'string'
          ? {
              createOnly: true,
              resourceSessionId: sessionId,
              agentId: creation.agentId,
              ...(typeof creation.memoryStoreId === 'string'
                ? { memoryStoreId: creation.memoryStoreId }
                : {}),
              skillIds: Array.isArray(creation.skillIds)
                ? creation.skillIds.filter((id) => typeof id === 'string')
                : [],
              adminPanelRequested: false,
              checkpoint: creation.checkpoint,
            }
          : undefined;
      let result;
      try {
        result = await service.accepted(
          object(response),
          sessionId,
          created ? false : options.wait !== false,
          {
            ...waitOptions(current),
            submittedInteractionId: interactionId,
          },
        );
      } catch (error) {
        if (!created) throw error;
        throw new CliError(
          error instanceof CliError ? error.code : 'OUTCOME_UNKNOWN',
          error instanceof Error ? error.message : '资源已创建，但后续状态查询未完成，勿重复创建',
          { ...(error instanceof CliError ? error.details : {}), managedAgentCreation: created },
        );
      }
      context.output.write({
        ...result,
        ...(created ? { managedAgentCreation: created } : {}),
      });
    });
  }
}
