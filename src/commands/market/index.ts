/** 浏览公开市场、读取详情和查价，市场入口不等于用户项目。@author xiuyu.yi */
import { InvalidArgumentError, Option } from 'commander';
import type { Command } from 'commander';
import { MarketQueryApi } from '../../api/market-query-api.js';
import type { MarketCopyType, MarketTarget } from '../../api/market-query-api.js';
import { CliError } from '../../output/exit-codes.js';
import type { CommandContext } from '../shared.js';
import { positive, runtime } from '../shared.js';

const CATEGORIES = [
  'All',
  'Website',
  'Personal',
  'Consumer App',
  'B2b App',
  'Prototype',
  'Game',
  'Internal Tools',
  'Other',
  'Interesting App',
  'Management App',
  'Other Websites',
];

function communityIdValue(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError('communityId 必须是单个正安全整数，不能使用作者 sessionId 或多个ID');
  return Number(value);
}
function targetValue(value: string): MarketTarget {
  if (/^[1-9]\d*$/.test(value)) return { communityId: communityIdValue(value) };
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/(?:web\/)?community-view\/([^/]+)\/?$/);
    if (
      url.protocol !== 'https:' ||
      !['superun.com', 'superun.ai'].includes(url.hostname) ||
      (url.port && url.port !== '443') ||
      url.username ||
      url.password ||
      !match ||
      /\s|\\/.test(value)
    )
      throw new Error('不是支持的市场入口');
    const key = decodeURIComponent(match[1]!);
    if (!key || /[\s,\/\\?#]/.test(key)) throw new Error('无效市场键');
    if (key.startsWith('snapshot--')) {
      const encryptedSnapshotId = key.slice('snapshot--'.length);
      if (!encryptedSnapshotId) throw new Error('缺少快照标识');
      return { encryptedSnapshotId };
    }
    return { sessionKey: key };
  } catch {
    throw new InvalidArgumentError(
      '请提供市场数字ID或 superun.com / superun.ai 的官方 community-view 入口链接；普通站点请先搜索',
    );
  }
}
function marketLimit(value: string): number {
  const limit = positive(value);
  if (limit > 100) throw new InvalidArgumentError('每页数量不能超过 100');
  return limit;
}

export function registerMarket(program: Command, context: CommandContext): void {
  const market = program.command('market').description('浏览公开应用市场并查询当前复刻价格');
  market
    .command('list')
    .description('按类别和关键词分页搜索公开市场作品')
    .option('--keyword <text>', '匹配作品标题、介绍或标签')
    .addOption(
      new Option('--category <category>', '市场类别，按后端已支持值查询').choices(CATEGORIES).default('All'),
    )
    .option('--page <number>', '页码，从 1 开始', positive, 1)
    .option('--limit <count>', '每页数量，最多 100', marketLimit, 20)
    .action(async (_options: unknown, command: Command) => {
      const {
        category,
        page,
        limit,
        keyword: rawKeyword,
      } = command.opts<{ category: string; page: number; limit: number; keyword?: string }>();
      if (page * limit > 2_147_483_647) throw new CliError('INVALID_ARGUMENT', '页码超出市场查询支持的范围');
      const keyword = rawKeyword?.trim() || undefined;
      const service = await runtime(context, command);
      const result = await new MarketQueryApi(service.client).list({ category, page, limit, keyword });
      const hasMore = page * limit < result.total;
      context.output.write({
        state: 'COMPLETED',
        category,
        keyword: keyword ?? null,
        page,
        limit,
        ...result,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      });
    });
  market
    .command('get')
    .argument('<target>', '本次明确的市场数字ID或官方市场入口链接', targetValue)
    .description('读取公开市场入口介绍、演示地址及可复刻类型')
    .action(async (target: MarketTarget, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const item = await new MarketQueryApi(service.client).get(target);
      context.output.write({ state: 'COMPLETED', item });
    });
  market
    .command('quote')
    .argument('<communityId>', '本次明确的市场入口数字ID', communityIdValue)
    .description('查询当前账号的指定类型复刻报价，不复制或下单')
    .addOption(
      new Option('--copy-type <type>', '从本次详情公布的类型中选择')
        .choices(['PROTOTYPE', 'FRONTEND_DEMO', 'FULL_APP'])
        .makeOptionMandatory(),
    )
    .action(async (communityId: number, _options: unknown, command: Command) => {
      const { copyType } = command.opts<{ copyType: MarketCopyType }>();
      const service = await runtime(context, command);
      const price = await new MarketQueryApi(service.client).quote(communityId, copyType);
      context.output.write({ state: 'COMPLETED', amountUnit: 'currency-minor', ...price });
    });
}
