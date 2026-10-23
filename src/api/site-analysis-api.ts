/** 网站分析只读接口与结果投影。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { parseWire } from '../contracts/node-wire.js';
import { object } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { REPORT_CATEGORIES, readPageSpeedReport } from '../site-analysis/pagespeed-report.js';

const optionalText = z.string().nullish();
const integer = z.number().int().safe();
const timestamp = integer.nullish();
const pagespeedSchema = z
  .object({
    sessionId: z.string().min(1),
    strategy: optionalText,
    status: integer.min(0).max(15),
    updatedAt: timestamp,
    accessibility: optionalText,
    bestPractices: optionalText,
    performance: optionalText,
    seo: optionalText,
  })
  .nullish();
const monitorSchema = z.object({
  sessionId: z.string().min(1),
  published: z.boolean(),
  currentPublishedSnapshotId: integer.nullish(),
  currentPublishedVersion: optionalText,
  planId: optionalText,
  status: optionalText,
  frequency: optionalText,
  outdated: z.boolean().nullish(),
  lastRunAt: timestamp,
  nextRunAt: timestamp,
  selectedEndpointIds: z.array(z.string()),
  candidates: z.array(
    z.object({
      id: z.string().min(1),
      displayName: optionalText,
      targetType: optionalText,
      method: optionalText,
      path: optionalText,
      monitorable: z.boolean().nullish(),
      blockedReasonCode: optionalText,
    }),
  ),
  latestResults: z.array(
    z.object({
      endpointId: z.string().min(1),
      status: z.string().min(1),
      httpStatus: integer.nullish(),
      latencyMs: integer.nonnegative().nullish(),
      checkedAt: timestamp,
    }),
  ),
  notice: optionalText,
});
const reportsSchema = z.array(
  z.object({
    id: z.string().min(1),
    weekStart: integer,
    weekEnd: integer,
    summary: z.string(),
    createdAt: integer,
  }),
);
const trafficRowsSchema = z
  .array(
    z.object({
      date: z.string().min(1),
      visits: z.number().finite().nonnegative(),
      pageviews: z.number().finite().nonnegative(),
    }),
  )
  .min(1);
const listRowsSchema = z
  .array(z.object({ label: z.string(), value: z.number().finite().nonnegative() }))
  .min(1);
const RESULT_EXPLANATIONS: Record<string, string> = {
  SUCCESS: '该监测项在记录时间检查成功，不代表整个网站当前健康',
  HTTP_ERROR: '该监测项返回了异常 HTTP 状态',
  AUTH_FAILED: '该监测项认证失败',
  TIMEOUT: '该监测项检查超时',
  NETWORK_BLOCKED: '该监测项网络访问受限',
  INCONCLUSIVE: '该监测项结果无法确定',
  PAUSED: '该监测项已暂停',
};

export type TrafficRange = 'today' | 'yesterday' | 'last7Days';
export const TRAFFIC_RANGE_DESCRIPTIONS: Record<TrafficRange, string> = {
  today: '服务端当天零点至今；时区由服务端决定',
  yesterday: '服务端昨天零点至今天零点前；时区由服务端决定',
  last7Days: '服务端7天前零点至今，并非固定最近168小时；时区由服务端决定',
};

function available(conditions: boolean[]): 'AVAILABLE' | 'PARTIAL' | 'UNKNOWN' {
  return conditions.every(Boolean) ? 'AVAILABLE' : conditions.some(Boolean) ? 'PARTIAL' : 'UNKNOWN';
}

export class SiteAnalysisApi {
  constructor(private readonly client: ApiClient) {}

  async traffic(sessionId: string, range: TrafficRange) {
    const params = new URLSearchParams({ timeRange: range, sessionId });
    const raw = parseWire(
      z.record(z.unknown()),
      (await this.client.request(`/web-api/analysis?${params}`, undefined, { method: 'GET' })).data,
    );
    const currentAvailable =
      typeof raw.currentVisitors === 'number' &&
      Number.isFinite(raw.currentVisitors) &&
      raw.currentVisitors > 0;
    const rows = trafficRowsSchema.safeParse(object(object(raw.timeSeries).result).data);
    const rawLists = Array.isArray(raw.lists) ? raw.lists.map(object) : [];
    const labels = { source: 'Source', page: 'Page', country: 'Country', device: 'Device' };
    const lists = Object.fromEntries(
      Object.entries(labels).map(([key, label]) => {
        const matches = rawLists.filter((entry) => entry.label === label);
        const parsed = listRowsSchema.safeParse(matches.length === 1 ? matches[0]?.data : undefined);
        return [
          key,
          {
            availability: parsed.success ? 'AVAILABLE' : 'UNKNOWN',
            items: parsed.success ? parsed.data.slice(0, 5) : [],
          },
        ];
      }),
    );
    return {
      availability: available([
        currentAvailable,
        rows.success,
        ...Object.values(lists).map((entry) => entry.availability === 'AVAILABLE'),
      ]),
      traffic: {
        currentVisitors: {
          availability: currentAvailable ? 'AVAILABLE' : 'UNKNOWN',
          value: currentAvailable ? raw.currentVisitors : null,
        },
        series: {
          availability: rows.success ? 'AVAILABLE' : 'UNKNOWN',
          items: rows.success ? rows.data : [],
        },
        lists,
      },
    };
  }

  async performance(sessionId: string) {
    const record = parseWire(
      pagespeedSchema,
      await this.client.call('/api/uxa-center/agent/AgentQuery/querySessionPagespeed', { sessionId }),
    );
    if (!record) return { availability: 'NO_REPORT', reports: [] };
    if (record.sessionId !== sessionId) throw new CliError('PROTOCOL_ERROR', '性能报告目标与本次作品不一致');
    const reports = await Promise.all(
      REPORT_CATEGORIES.map((category) =>
        readPageSpeedReport(sessionId, category, record[category.field], record.status, this.client.signal),
      ),
    );
    return {
      availability: available(reports.map((report) => report.availability === 'AVAILABLE')),
      recordedAt: record.updatedAt ?? null,
      strategy: record.strategy ?? null,
      statusMask: record.status,
      reports,
    };
  }

  async overview(sessionId: string) {
    const monitor = parseWire(
      monitorSchema,
      await this.client.call('/api/uxa-center/agent/RuntimeMonitor/overview', { sessionId }),
    );
    if (monitor.sessionId !== sessionId) throw new CliError('PROTOCOL_ERROR', '巡检结果目标与本次作品不一致');
    return {
      ...monitor,
      latestResults: monitor.latestResults.map((result) => ({
        ...result,
        selected: monitor.selectedEndpointIds.includes(result.endpointId),
        statusExplanation: RESULT_EXPLANATIONS[result.status] ?? '未知监测状态，不能判断是否健康',
      })),
    };
  }

  async reports(sessionId: string, page: number, pageSize: number) {
    const items = parseWire(
      reportsSchema,
      await this.client.call('/api/uxa-center/agent/RuntimeMonitor/reports', { sessionId, page, pageSize }),
    );
    if (items.length > pageSize) throw new CliError('PROTOCOL_ERROR', '巡检周报返回数量超过请求页大小');
    return items;
  }
}
