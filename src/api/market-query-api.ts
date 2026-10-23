/** 公开市场浏览与买家报价，只查询，不触发复刻或支付。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';

const PREFIX = '/api/uxa-center/agent/AgentCommunity';
const id = z.number().int().positive().safe();
const optionalText = z.string().nullish();
const timestamp = z.number().int().safe().nullish();
const simpleConfigSchema = z.object({ copyType: z.string().min(1) });
const cardSchema = z.object({
  communityId: id,
  communityType: optionalText,
  title: optionalText,
  description: optionalText,
  websiteIntroduction: optionalText,
  category: optionalText,
  tags: z.array(z.string()).nullish(),
  visitUrl: optionalText,
  coverImage: optionalText,
  previewImage: optionalText,
  authorName: optionalText,
  createdAt: timestamp,
  updatedAt: timestamp,
  copyConfigs: z.array(simpleConfigSchema).nullish(),
});
const pageSchema = z.object({ total: z.number().int().nonnegative().safe(), items: z.array(cardSchema) });
const detailSchema = z.object({
  communityId: id,
  communityType: optionalText,
  authorName: optionalText,
  copyConfigs: z
    .array(
      z.object({
        configId: id,
        copyType: z.string().min(1),
        description: optionalText,
        websiteIntroduction: optionalText,
        snapshotCreatedAt: timestamp,
        previewVersionName: optionalText,
      }),
    )
    .nullish(),
});
const priceSchema = z.object({
  communityId: id,
  configId: id,
  copyType: z.string().min(1),
  amount: z.number().int().nonnegative().safe(),
  originalAmount: z.number().int().nonnegative().safe().nullish(),
  currency: z.string().trim().min(1),
  rate: z.number().int().positive().safe(),
  limitedSpecial: z.boolean().nullish(),
  limitedSpecialRemainingCount: z.number().int().nonnegative().safe().nullish(),
});

export type MarketTarget = { communityId: number } | { sessionKey: string } | { encryptedSnapshotId: string };
export type MarketCopyType = 'PROTOTYPE' | 'FRONTEND_DEMO' | 'FULL_APP';
export type MarketListQuery = { category: string; keyword?: string; page: number; limit: number };

/** 普通浏览链接不能携带会恢复复刻、支付单或复制轮询的动作参数。 */
function displayUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    for (const key of ['autoRemix', 'autoFullAppCopy', 'cashOrderNo', 'copyingSessionId'])
      url.searchParams.delete(key);
    return url.toString();
  } catch {
    return null;
  }
}

function cardView(card: z.infer<typeof cardSchema>) {
  const { copyConfigs, ...fields } = card;
  return {
    ...fields,
    visitUrl: displayUrl(card.visitUrl),
    coverImage: displayUrl(card.coverImage),
    previewImage: displayUrl(card.previewImage),
    copyTypes: (copyConfigs ?? []).map((config) => config.copyType),
  };
}

export class MarketQueryApi {
  constructor(private readonly client: ApiClient) {}

  async list(query: MarketListQuery) {
    const result = parseWire(
      pageSchema,
      await this.client.call(`${PREFIX}/queryByCategory`, {
        category: query.category,
        page: query.page,
        pageSize: query.limit,
        orderBy: 'popularity',
        device: 'pc',
        ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
      }),
    );
    if (result.items.length > query.limit || result.items.length > result.total)
      throw new CliError('PROTOCOL_ERROR', '市场列表数量与页大小或总数不一致');
    return { total: result.total, items: result.items.map(cardView) };
  }

  private async resolveId(target: MarketTarget): Promise<number> {
    if ('communityId' in target) return target.communityId;
    const result = parseWire(
      z.object({ communityId: id }).nullish(),
      await this.client.call(
        `${PREFIX}/queryBySessionKey`,
        'sessionKey' in target
          ? { sessionKey: target.sessionKey }
          : { encryptedSnapshotId: target.encryptedSnapshotId },
      ),
    );
    if (!result) throw new CliError('BUSINESS_ERROR', '该链接未找到当前公开可用的市场作品，请搜索作品后选择');
    return result.communityId;
  }

  async get(target: MarketTarget) {
    const communityId = await this.resolveId(target);
    // 解析接口可能返回子版本；再走公开入口过滤，不沿 parentId 静默切换目标。
    const cards = parseWire(
      z.array(cardSchema),
      await this.client.call(`${PREFIX}/queryByCommunityIds`, { communityIds: [communityId] }),
    );
    if (cards.length === 0)
      throw new CliError('BUSINESS_ERROR', '该市场入口当前不可用或未公开，请重新搜索并选择');
    if (cards.length !== 1 || cards[0]?.communityId !== communityId)
      throw new CliError('PROTOCOL_ERROR', '市场卡片与本次查询目标不一致');
    const detail = parseWire(
      detailSchema,
      await this.client.call(`${PREFIX}/queryMarketWorkDetail`, { communityId }),
    );
    if (detail.communityId !== communityId)
      throw new CliError('PROTOCOL_ERROR', '市场详情改变了本次查询目标');
    const copyConfigs = detail.copyConfigs ?? [];
    return {
      ...cardView(cards[0]),
      communityType: detail.communityType ?? cards[0].communityType,
      authorName: detail.authorName ?? cards[0].authorName,
      copyTypes: copyConfigs.map((config) => config.copyType),
      copyConfigs,
    };
  }

  async quote(communityId: number, copyType: MarketCopyType) {
    const item = await this.get({ communityId });
    const configs = item.copyConfigs.filter((config) => config.copyType === copyType);
    if (configs.length === 0)
      throw new CliError('BUSINESS_ERROR', '该作品当前未公布所选复刻类型，请重新查看可用类型');
    if (configs.length !== 1)
      throw new CliError('PROTOCOL_ERROR', '所选复刻类型存在多个配置，无法确定报价目标');
    const price = parseWire(
      priceSchema,
      await this.client.call('/api/uxa-center/agent/AgentToken/queryMarketWorkRemixCost', {
        communityId,
        copyType,
      }),
    );
    if (
      price.communityId !== communityId ||
      price.copyType !== copyType ||
      price.configId !== configs[0]?.configId
    )
      throw new CliError('PROTOCOL_ERROR', '报价作品或复制版本已变化，请重新查看详情后查询');
    return price;
  }
}
