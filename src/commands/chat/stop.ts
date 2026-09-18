/** 停止远端任务。@author xiuyu.yi */
import type { Command } from 'commander';
import { Option } from 'commander';
import { object, text } from '../../contracts/value.js';
import type { CommandContext } from '../shared.js';
import { runtime, businessWrite } from '../shared.js';
import { securityActive } from '../../api/security-review-api.js';
import { CliError } from '../../output/exit-codes.js';

export function registerStop(chat: Command, context: CommandContext): void {
  chat
    .command('stop <sessionId>')
    .description('停止远端任务')
    .option('--message-id <messageId>', '指定任务消息')
    .option('--review-id <reviewId>', '只取消指定安全扫描及其自动修复')
    .addOption(new Option('--scope <scope>', '停止范围').choices(['own', 'all']).default('own'))
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command),
        options = object(command.opts());
      if (options.reviewId && (options.messageId || options.scope === 'all'))
        throw new CliError('INVALID_ARGUMENT', '指定安全扫描时不能同时指定消息或全部停止');
      const reviewId = text(options.reviewId);
      if (reviewId) {
        const review = await service.security.query(sessionId, reviewId);
        if (!review.found || !securityActive(review))
          throw new CliError('INVALID_ARGUMENT', '该安全扫描已结束或不存在，无需取消', {
            sessionId,
            reviewId,
          });
        await businessWrite(context, service, sessionId, () => service.security.cancel(sessionId, reviewId));
        context.output.write(await service.state(sessionId, reviewId));
        return;
      }
      await businessWrite(context, service, sessionId, () =>
        service.command.stop(sessionId, options.scope === 'all' ? 'all' : 'own', text(options.messageId)),
      );
      context.output.write({ state: 'COMPLETED', sessionId });
    });
}
