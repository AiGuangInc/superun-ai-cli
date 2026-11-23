/** 算力账单读取契约，账户和消费者权限由服务端限定。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { parseWire } from '../contracts/node-wire.js';
import { getSuperunHostingDomain } from '../config/runtime-config.js';
import {
  callAccountQuery,
  listWorkspaces,
  managesWorkspace,
  type UserWorkspace,
} from './account-query-api.js';
import { CliError } from '../output/exit-codes.js';

const PREFIX = '/api/uxa-center/ecommerce/TokenBalance';
const optionalText = z.string().nullish();
const integer = z.number().int().safe();
const timestamp = integer.nullish();
const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const scrollIdSchema = z
  .string()
  .refine(
    (value) => value.length <= 19 && /^[1-9]\d*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
  );

const billPageSchema = z.object({
  hasNext: z.boolean(),
  scrollId: scrollIdSchema.nullish(),
  items: z.array(
    z.object({
      billKey: z.string().min(1),
      type: integer,
      relatedType: integer.nullish(),
      relatedTypeContent: optionalText,
      relatedTypeL1: integer.nullish(),
      relatedTypeL1Content: optionalText,
      amount: integer,
      createdAt: timestamp,
      billTime: timestamp,
      updatedAt: timestamp,
      aiMessageRunning: z.boolean().nullish(),
      hasSubBill: z.boolean().nullish(),
      apiName: optionalText,
      modelName: optionalText,
      efforts: optionalText,
      projectCloudPackageAmount: integer.nullish(),
      projectCloudPackageProjectTitle: optionalText,
      relatedEntity: z.object({ sessionId: optionalText, title: optionalText }).nullish(),
    }),
  ),
});
const billStatisticsSchema = z.object({
  totalAmount: decimal,
  items: z.array(
    z.object({
      startDate: date,
      endDate: date,
      sessionId: optionalText,
      sessionName: optionalText,
      relatedType: integer.nullish(),
      amount: decimal,
    }),
  ),
});
const billProjectsSchema = z.array(z.object({ sessionId: z.string().min(1), topic: optionalText }));
const billTypesSchema = z.array(z.object({ code: integer.nonnegative(), desc: z.string() }));
const accountSchema = z.object({
  balances: z.array(
    z.object({
      currency: z.string(),
      ownerType: z.string().nullish(),
      ownerId: z.union([z.string(), z.number()]).nullish(),
      balanceStr: z.string().nullish(),
    }),
  ),
});

export type BillFilters = {
  workspaceId?: string;
  sessionId?: string;
  relatedTypes?: number[];
};
export type BillStatisticsQuery = BillFilters & {
  startDate: string;
  endDate: string;
  granularity: 'DAY' | 'WEEK' | 'MONTH';
};

/** 只发送领域接口支持的筛选，身份和任意外来字段不透传。 */
function filterRequest(filters: BillFilters) {
  return {
    currency: 'GLOW_TOKEN',
    ...(filters.workspaceId === undefined ? {} : { workspaceId: filters.workspaceId }),
    ...(filters.sessionId === undefined ? {} : { sessionId: filters.sessionId }),
    ...(filters.relatedTypes === undefined ? {} : { relatedTypes: filters.relatedTypes }),
  };
}

export class BillQueryApi {
  constructor(private readonly client: ApiClient) {}

  async balance(workspaceId?: string) {
    if (workspaceId === undefined) return this.readAccountBalance();
    const teams = await listWorkspaces(this.client);
    const result = await this.workspaceBalance(teams.find((team) => team.workspaceId === workspaceId));
    const current = await listWorkspaces(this.client);
    this.assertMayReadWorkspace(current.find((team) => team.workspaceId === workspaceId));
    return result;
  }

  async workspaceBalance(team: UserWorkspace | undefined) {
    this.assertMayReadWorkspace(team);
    return this.readAccountBalance(team.workspaceId);
  }

  private assertMayReadWorkspace(team: UserWorkspace | undefined): asserts team is UserWorkspace {
    const endpoint = this.client.config.endpoint;
    const hostname = new URL(endpoint).hostname;
    const intl =
      hostname === 'superun.ai' ||
      hostname.endsWith('.superun.ai') ||
      hostname === 'uxarts-glow.pre.oversea.qima-inc.com';
    const knownSite = intl || getSuperunHostingDomain(endpoint) === 'superun.yun';
    if (!team || !knownSite || !managesWorkspace(team)) {
      const message =
        team?.role === 'user' && !team.isManager
          ? '你是该团队的普通成员。团队余额仅限该团队的主账号或管理员查询。'
          : '当前账号无权查看该团队的算力余额。';
      throw new CliError('AUTH_REQUIRED', message, { authFailure: 'ACCESS_DENIED' });
    }
  }

  private async readAccountBalance(workspaceId?: string) {
    const account = parseWire(
      accountSchema,
      await callAccountQuery(this.client, '/api/uxa-center/support/UserAccount/queryAccount', {
        product: 13,
        ...(workspaceId === undefined ? {} : { workspaceId, includeProjectCloudBalance: true }),
      }),
    );
    const entry = account.balances.find((item) => {
      if (item.currency !== 'GLOW_TOKEN') return false;
      if (workspaceId === undefined)
        return item.ownerType === 'user' || (item.ownerType == null && String(item.ownerId) === '0');
      return (
        item.ownerType === 'workspace' &&
        (typeof item.ownerId === 'string' || Number.isSafeInteger(item.ownerId)) &&
        String(item.ownerId) === workspaceId
      );
    });
    if (!entry?.balanceStr || !decimal.safeParse(entry.balanceStr).success)
      throw new CliError('PROTOCOL_ERROR', '所选账户的算力余额未返回有效数值，不能按零处理');
    return { balanceStr: entry.balanceStr };
  }

  async page(filters: BillFilters, cursor?: string) {
    const result = parseWire(
      billPageSchema,
      await this.client.call(`${PREFIX}/pageBill`, {
        ...filterRequest(filters),
        scrollQuery: { size: 100, ...(cursor === undefined ? {} : { scrollId: cursor }) },
      }),
    );
    if (result.hasNext && !result.scrollId)
      throw new CliError('PROTOCOL_ERROR', '账单还有下一页，但接口未返回有效游标');
    if (cursor && result.scrollId && BigInt(result.scrollId) >= BigInt(cursor))
      throw new CliError('PROTOCOL_ERROR', '账单游标未向更早记录推进，请勿重复翻页');
    // 服务端聚合和过滤运行中记录后可能返回空展示页，结束与否只认 hasNext。
    return { ...result, scrollId: result.scrollId ?? null };
  }

  async statistics(query: BillStatisticsQuery) {
    return parseWire(
      billStatisticsSchema,
      await this.client.call(`${PREFIX}/queryBillStatistics`, {
        ...filterRequest(query),
        startDate: query.startDate,
        endDate: query.endDate,
        granularity: query.granularity,
      }),
    );
  }

  async projects(workspaceId?: string) {
    return parseWire(
      billProjectsSchema,
      await this.client.call(
        `${PREFIX}/listTokenBillProjects`,
        workspaceId === undefined ? {} : { workspaceId },
      ),
    );
  }

  async types() {
    return parseWire(billTypesSchema, await this.client.call(`${PREFIX}/listGlowTokenRelatedTypes`, {}));
  }
}
