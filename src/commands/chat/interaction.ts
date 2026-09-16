/** 提交当前交互的回答。@author xiuyu.yi */
import { CliError } from '../../output/exit-codes.js';
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime, readInput, withWait, waitOptions, businessWrite } from '../shared.js';
import { object, requiredText } from '../../contracts/value.js';

export function registerInteraction(chat: Command, context: CommandContext): void {
  const interaction = chat.command('interaction').description('回答或跳过交互');
  const command = withWait(
    interaction.command('reply <sessionId> <interactionId>').description('回复当前交互'),
    '本次回答处理结束后，不继续等待后续创作',
  );
  command.requiredOption('--input <file>', 'response JSON 文件，- 表示标准输入');
  command.action(async (sessionId: string, interactionId: string, _options: unknown, current: Command) => {
    const options = object(current.opts()),
      service = await runtime(context, current);
    const input = await readInput(requiredText(options.input, 'input'));
    if (!('response' in input))
      throw new CliError('INVALID_ARGUMENT', '请按当前交互的 view.reply 使用 response 格式回答');
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
