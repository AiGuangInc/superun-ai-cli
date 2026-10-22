/** 查询本人购买的 superun 产品和服务订单。@author xiuyu.yi */
import { InvalidArgumentError, Option } from 'commander';
import type { Command } from 'commander';
import { OrderQueryApi } from '../../api/order-query-api.js';
import { CliError } from '../../output/exit-codes.js';
import type { CommandContext } from '../shared.js';
import { positive, runtime } from '../shared.js';

function orderLimit(value: string): number {
  const limit = positive(value);
  if (limit > 100) throw new InvalidArgumentError('每页数量不能超过 100');
  return limit;
}

export function registerOrder(program: Command, context: CommandContext): void {
  const order = program.command('order').description('查询本人购买的 superun 产品和服务订单');
  order
    .command('list')
    .description('分页查询购买订单、商品、订单金额和已有发票信息')
    .option('--page <number>', '页码，从 1 开始', positive, 1)
    .option('--limit <count>', '每页数量，最多 100', orderLimit, 20)
    .addOption(
      new Option(
        '--status <code>',
        '订单状态：0 初始化、10 待支付、20 已支付、50 已完成、60 已关闭、70 已取消',
      ).choices(['0', '10', '20', '50', '60', '70']),
    )
    .action(async (_options: unknown, command: Command) => {
      const { page, limit, status } = command.opts<{ page: number; limit: number; status?: string }>();
      if (page > 2_147_483_647 || (page - 1) * limit > 2_147_483_647)
        throw new CliError('INVALID_ARGUMENT', '页码超出订单查询支持的范围');
      const service = await runtime(context, command);
      const statusFilter = status === undefined ? undefined : Number(status);
      const result = await new OrderQueryApi(service.client).page(page, limit, statusFilter);
      const hasMore = page * limit < result.total;
      context.output.write({
        state: 'COMPLETED',
        scope: 'current-user-purchases',
        page,
        limit,
        statusFilter: statusFilter ?? null,
        amountUnit: 'minor',
        ...result,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      });
    });
}
