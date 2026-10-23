/** 对明确的单个作品读取流量、历史检测和已有巡检。@author xiuyu.yi */
import { InvalidArgumentError, Option } from 'commander';
import type { Command } from 'commander';
import { SiteAnalysisApi, TRAFFIC_RANGE_DESCRIPTIONS } from '../../api/site-analysis-api.js';
import type { TrafficRange } from '../../api/site-analysis-api.js';
import { CliError } from '../../output/exit-codes.js';
import type { CommandContext } from '../shared.js';
import { positive, runtime } from '../shared.js';

function sessionValue(value: string): string {
  if (!value || /[\s,\/\\?#]/.test(value))
    throw new InvalidArgumentError('请传入本次明确的单个 sessionId，不能是链接或多个目标');
  return value;
}
function reportLimit(value: string): number {
  const limit = positive(value);
  if (limit > 100) throw new InvalidArgumentError('每页周报数量不能超过 100');
  return limit;
}

async function target(context: CommandContext, command: Command, sessionId: string) {
  const service = await runtime(context, command);
  const view = await service.load(sessionId);
  if (view.session.sessionId !== sessionId)
    throw new CliError('PROTOCOL_ERROR', '返回作品与本次查询目标不一致');
  return {
    api: new SiteAnalysisApi(service.client),
    session: view.session,
    output: { state: 'COMPLETED', sessionId, topic: view.session.topic },
  };
}

export function registerSite(program: Command, context: CommandContext): void {
  const site = program.command('site').description('分析作品流量、已有性能报告和运行巡检');
  site
    .command('traffic')
    .argument('<sessionId>', '本次明确的单个作品 ID', sessionValue)
    .description('查看已公开作品的有效访问序列和榜单，歧义零值保留未知')
    .addOption(
      new Option('--range <range>', '服务端日期范围')
        .choices(['today', 'yesterday', 'last7Days'])
        .default('last7Days'),
    )
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const current = await target(context, command, sessionId);
      const { range } = command.opts<{ range: TrafficRange }>();
      const common = {
        ...current.output,
        publicStatus: current.session.publicStatus ?? null,
        range,
        rangeDescription: TRAFFIC_RANGE_DESCRIPTIONS[range],
      };
      if (current.session.publicStatus !== 1) {
        context.output.write({
          ...common,
          availability: current.session.publicStatus === 0 ? 'NOT_AVAILABLE' : 'UNKNOWN',
          reason:
            current.session.publicStatus === 0
              ? '作品当前未公开，流量查询入口不可用'
              : '作品公开状态缺失或未知，无法判断流量查询是否可用',
        });
        return;
      }
      context.output.write({ ...common, ...(await current.api.traffic(sessionId, range)) });
    });

  site
    .command('performance')
    .argument('<sessionId>', '本次明确的单个作品 ID', sessionValue)
    .description('读取已有性能与 SEO 原始报告，不发起新检测')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const current = await target(context, command, sessionId);
      context.output.write({
        ...current.output,
        ...(await current.api.performance(sessionId)),
        note: '已有历史检测结果；检测时网址和分数不能证明当前发布域名或当前版本状态。',
      });
    });

  site
    .command('runtime')
    .argument('<sessionId>', '本次明确的单个作品 ID', sessionValue)
    .description('读取已有运行巡检状态和结果，不创建或启用计划')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const current = await target(context, command, sessionId);
      const monitor = await current.api.overview(sessionId);
      context.output.write({
        ...current.output,
        availability: monitor.latestResults.length ? 'AVAILABLE' : monitor.planId ? 'UNKNOWN' : 'NO_REPORT',
        monitor,
      });
    });

  site
    .command('reports')
    .argument('<sessionId>', '本次明确的单个作品 ID', sessionValue)
    .description('查询已有巡检周报，不生成新报告')
    .option('--page <number>', '页码，从 1 开始', positive, 1)
    .option('--limit <count>', '每页数量，最多 100', reportLimit, 20)
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const { page, limit } = command.opts<{ page: number; limit: number }>();
      if (page > 2_147_483_647 || (page - 1) * limit > 2_147_483_647)
        throw new CliError('INVALID_ARGUMENT', '页码超出巡检周报查询范围');
      const current = await target(context, command, sessionId);
      const monitor = await current.api.overview(sessionId);
      const items = await current.api.reports(sessionId, page, limit);
      context.output.write({
        ...current.output,
        availability: items.length ? 'AVAILABLE' : 'NO_REPORT',
        monitorContext: {
          published: monitor.published,
          status: monitor.status ?? null,
          outdated: monitor.outdated ?? null,
          currentPublishedVersion: monitor.currentPublishedVersion ?? null,
        },
        page,
        limit,
        items,
        hasMore: items.length < limit ? false : null,
        nextPage: items.length < limit ? null : page + 1,
      });
    });
}
