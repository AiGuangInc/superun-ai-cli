/** 查询项目列表。@author xiuyu.yi */
import type { Command } from 'commander';
import { Option } from 'commander';
import { list, object } from '../../contracts/value.js';
import type { CommandContext } from '../shared.js';
import { runtime, positive } from '../shared.js';

export function registerList(session: Command, context: CommandContext): void {
  session
    .command('list')
    .description('查询项目列表')
    .option('--limit <count>', '每页数量', positive, 20)
    .option('--keyword <text>', '按项目名或 ID 筛选')
    .addOption(
      new Option('--scope <scope>', '项目范围').choices(['all', 'mine', 'team', 'shared']).default('all'),
    )
    .option('--cursor-updated-at <timestamp>', '上一页更新时间游标', positive)
    .option('--id-lt <id>', '上一页 ID 游标', positive)
    .action(async (_options: unknown, command: Command) => {
      const service = await runtime(context, command),
        options = object(command.opts());
      const page = await service.query.sessions({
        pageSize: options.limit,
        keyword: options.keyword,
        scopes: [options.scope],
        cursorUpdatedAt: options.cursorUpdatedAt,
        idLT: options.idLt,
      });
      const items = list(page.items ?? page.list ?? page.data)
        .map(object)
        .map((item) => ({
          sessionId: item.sessionId,
          topic: item.topic,
          status: item.status,
          updatedAt: item.updatedAt,
          id: item.id,
          workspaceId: item.workspaceId,
        }));
      context.output.write({
        state: 'COMPLETED',
        items,
        total: page.totalCount,
        hasMore: page.hasMore,
        cursor: items.length
          ? { cursorUpdatedAt: items.at(-1)?.updatedAt, idLT: items.at(-1)?.id }
          : undefined,
      });
    });
}
