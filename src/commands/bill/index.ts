/** 查询算力账单明细、扣减汇总和筛选目录。@author xiuyu.yi */
import { InvalidArgumentError, Option } from 'commander';
import type { Command } from 'commander';
import { BillQueryApi } from '../../api/bill-query-api.js';
import type { BillFilters, BillStatisticsQuery } from '../../api/bill-query-api.js';
import { CliError } from '../../output/exit-codes.js';
import type { CommandContext } from '../shared.js';
import { runtime } from '../shared.js';

function positiveLong(value: string): string {
  if (value.length > 19 || !/^[1-9]\d*$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n)
    throw new InvalidArgumentError('参数必须是 Java Long 范围内的正整数字符串，不能传 0');
  return value;
}

function sessionValue(value: string): string {
  if (!value || /[\s,]/.test(value))
    throw new InvalidArgumentError('请传入本次明确的单个 sessionId，不能包含空格或逗号');
  return value;
}

function typeValues(value: string): number[] {
  const parts = value.split(',');
  if (parts.some((part) => !/^\d+$/.test(part) || Number(part) > 2_147_483_647))
    throw new InvalidArgumentError('消费类型必须是逗号分隔的 0 至 2147483647 整数，不能有空项');
  return [...new Set(parts.map(Number))];
}

function dateValue(value: string): string {
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  )
    throw new InvalidArgumentError('日期必须是真实有效的 YYYY-MM-DD');
  return value;
}

function withWorkspace(command: Command): Command {
  return command.option('--workspace-id <id>', '明确的工作空间 ID；省略查询个人账单', positiveLong);
}

function withFilters(command: Command): Command {
  return withWorkspace(command)
    .option('--session-id <id>', '在既定账单账户内筛选本次明确的单个作品', sessionValue)
    .option('--related-types <codes>', '逗号分隔的业务类型 code，先通过 bill types 查询', typeValues);
}

function queryScope(filters: BillFilters) {
  return {
    currency: 'GLOW_TOKEN',
    scope: filters.workspaceId === undefined ? 'personal' : 'workspace',
    workspaceId: filters.workspaceId ?? null,
    sessionId: filters.sessionId ?? null,
    relatedTypes: filters.relatedTypes ?? [],
  };
}

export function registerBill(program: Command, context: CommandContext): void {
  const bill = program.command('bill').description('查询算力账单和扣减类统计');
  withFilters(bill.command('list').description('查询算力账单明细，按服务端游标翻页，无日期或条数选项'))
    .option('--cursor <scrollId>', '上次返回的 scrollId；账户或筛选变化时省略', positiveLong)
    .action(async (_options: unknown, command: Command) => {
      const filters = command.opts<BillFilters & { cursor?: string }>();
      const service = await runtime(context, command);
      const result = await new BillQueryApi(service.client).page(filters, filters.cursor);
      context.output.write({
        state: 'COMPLETED',
        ...queryScope(filters),
        amountUnit: 'hundredth-credit',
        ...result,
      });
    });

  withFilters(bill.command('stats').description('按日期汇总扣减类账单，含负数冲正，不含充值类用量返还'))
    .requiredOption('--from <date>', '开始日期 YYYY-MM-DD，按上海时区且包含当天', dateValue)
    .requiredOption('--to <date>', '结束日期 YYYY-MM-DD，含首尾最多 60 天', dateValue)
    .addOption(
      new Option('--granularity <period>', '统计粒度').choices(['DAY', 'WEEK', 'MONTH']).default('DAY'),
    )
    .action(async (_options: unknown, command: Command) => {
      const options = command.opts<
        BillFilters & {
          from: string;
          to: string;
          granularity: BillStatisticsQuery['granularity'];
        }
      >();
      const days =
        (Date.parse(`${options.to}T00:00:00.000Z`) - Date.parse(`${options.from}T00:00:00.000Z`)) /
          86_400_000 +
        1;
      if (days < 1 || days > 60)
        throw new CliError('INVALID_ARGUMENT', '开始日期不能晚于结束日期，且含首尾最多 60 天');
      const service = await runtime(context, command);
      const result = await new BillQueryApi(service.client).statistics({
        ...options,
        startDate: options.from,
        endDate: options.to,
      });
      context.output.write({
        state: 'COMPLETED',
        ...queryScope(options),
        startDate: options.from,
        endDate: options.to,
        granularity: options.granularity,
        timeZone: 'Asia/Shanghai',
        amountUnit: 'credit',
        statisticsScope: '仅统计扣减类账单（type=2），包含负数冲正，不包含充值类用量返还。',
        ...result,
      });
    });

  withWorkspace(bill.command('projects').description('查询账单作品筛选候选，不代表当前编辑权限')).action(
    async (_options: unknown, command: Command) => {
      const options = command.opts<{ workspaceId?: string }>();
      const service = await runtime(context, command);
      const items = await new BillQueryApi(service.client).projects(options.workspaceId);
      context.output.write({ state: 'COMPLETED', ...queryScope(options), items });
    },
  );

  bill
    .command('types')
    .description('查询算力账单支持的充值和消费业务类型')
    .action(async (_options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const items = await new BillQueryApi(service.client).types();
      context.output.write({ state: 'COMPLETED', currency: 'GLOW_TOKEN', items });
    });
}
