/** 查询作品主线历史版本。@author xiuyu.yi */
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { positive, runtime } from '../shared.js';
import { CliError } from '../../output/exit-codes.js';

function sessionIdValue(value: string): string {
  if (!value.trim() || value !== value.trim())
    throw new InvalidArgumentError('sessionId 必须非空且不能包含首尾空格');
  return value;
}

function historyLimit(value: string): number {
  const limit = positive(value);
  if (limit > 100) throw new InvalidArgumentError('每页数量不能超过 100');
  return limit;
}

export function registerHistory(session: Command, context: CommandContext): void {
  session
    .command('history')
    .argument('<sessionId>', '本次查询的唯一作品 ID', sessionIdValue)
    .description('查询作品主线历史版本摘要，不含独立演示版本或源码')
    .option('--page <number>', '页码，从 1 开始', positive, 1)
    .option('--limit <count>', '每页数量，最多 100', historyLimit, 20)
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const { page, limit } = command.opts<{ page: number; limit: number }>();
      // 后端使用 Java Integer 计算分页偏移，避免越界后查询到错误页。
      if (page > 2_147_483_647 || (page - 1) * limit > 2_147_483_647)
        throw new CliError('INVALID_ARGUMENT', '页码超出历史查询支持的范围');
      const service = await runtime(context, command);
      const view = await service.load(sessionId);
      if (view.session.sessionId !== sessionId)
        throw new CliError('PROTOCOL_ERROR', '返回的作品与本次查询目标不一致');
      const result = await service.query.snapshotHistory(sessionId, page, limit);
      if (result.items.length > limit)
        throw new CliError('PROTOCOL_ERROR', '历史查询返回的数量超过本次请求的页大小');
      const hasMore =
        result.total === null ? (result.items.length < limit ? false : null) : page * limit < result.total;
      context.output.write({
        state: 'COMPLETED',
        sessionId,
        topic: view.session.topic,
        previewVersionId: 0,
        page,
        limit,
        ...result,
        hasMore,
        // 满页但没有总数时，仅给出待查询页码，不声称后续一定还有记录。
        nextPage: hasMore === false ? null : page + 1,
      });
    });
}
