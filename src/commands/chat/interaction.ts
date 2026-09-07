/** 提交当前交互的回答。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime, readInput, withWait, waitOptions, businessWrite } from '../shared.js';
import { object, requiredText } from '../../contracts/value.js';

export function registerInteraction(chat: Command, context: CommandContext): void {
  const interaction = chat.command('interaction').description('回答或跳过交互');
  for (const action of ['reply', 'skip']) {
    const command = withWait(
      interaction
        .command(`${action} <sessionId> <interactionId>`)
        .description(action === 'reply' ? '提交回答' : '跳过当前交互'),
      '本次回答处理结束后，不继续等待后续创作',
    );
    if (action === 'reply') command.requiredOption('--input <file>', '回答 JSON 文件，- 表示标准输入');
    command.action(async (sessionId: string, interactionId: string, _options: unknown, current: Command) => {
      const options = object(current.opts()),
        service = await runtime(context, current);
      const input =
        action === 'skip' ? { action: 'SKIP' } : await readInput(requiredText(options.input, 'input'));
      const response = await businessWrite(context, service, sessionId, () =>
        service.reply(sessionId, interactionId, input),
      );
      context.output.write(
        await service.accepted(object(response), sessionId, options.wait !== false, {
          ...waitOptions(current),
          submittedInteractionId: interactionId,
        }),
      );
    });
  }
}
