/** 主站固定算力套餐、实时报价及本人订单读取。@author xiuyu.yi */
import { z } from 'zod';
import { DEFAULT_ENDPOINT } from '../config/constants.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';
import type { ApiClient } from '../transport/api-client.js';
import { listWorkspaces } from './account-query-api.js';

const commerce = '/api/uxa-center/ecommerce';
const integer = z.number().int().safe();
const positiveId = integer.positive();
const money = integer.nonnegative();
export const orderNumber = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const amountFields = { currencyCode: z.string().min(1), total: money };
const selection = { itemId: positiveId, skuId: positiveId, num: positiveId };
export type Selection = { itemId: number; skuId: number; num: number };
const price = z.object({
  skuId: positiveId,
  rawPrice: money,
  unit: z.string().nullish(),
  title: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
});
const catalog = z.object({
  currency: z.string().nullish(),
  items: z.array(
    z.object({ itemId: positiveId, title: z.string(), currency: z.string(), prices: z.array(price) }),
  ),
});
const preview = z.object({
  bookKey: z.string().min(1),
  total: money,
  items: z.array(z.object({ ...selection, total: money })),
});
const detail = z.object({
  orderInfo: z.object({
    orderNo: orderNumber,
    status: integer,
    ...amountFields,
    bookKey: z.string().nullish(),
    extra: z
      .object({
        product: integer.nullish(),
        ownerType: z.string().nullish(),
        ownerId: z.union([z.string(), z.number()]).nullish(),
      })
      .nullish(),
  }),
  orderItems: z.array(z.unknown()).nullish(),
});
const ownedPage = z.object({
  total: money,
  items: z.array(z.object({ orderInfo: z.object({ orderNo: orderNumber, bookKey: z.string().nullish() }) })),
});
const states = new Map([
  [0, 'INITIALIZING'],
  [10, 'WAIT_PAYMENT'],
  [20, 'PAID'],
  [50, 'COMPLETED'],
  [60, 'CLOSED'],
  [70, 'CANCELLED'],
]);

export function assertMainPurchaseSite(endpoint: string) {
  // 购买只使用已核验商品、订单和收银台路由的主站 API 源站。
  if (endpoint !== DEFAULT_ENDPOINT)
    throw new CliError('UNSUPPORTED_INTERACTION', '当前 CLI 仅支持在主站 superun.com 购买。');
}

export async function requireTeamBuyer(client: ApiClient, workspaceId: string) {
  const team = (await listWorkspaces(client)).find((t) => t.workspaceId === workspaceId);
  if (!team?.isManager)
    throw new CliError('AUTH_REQUIRED', '团队购买仅限该团队的主账号或管理员。', {
      authFailure: 'ACCESS_DENIED',
    });
}

export async function fixedProducts(client: ApiClient, workspaceId?: string) {
  if (workspaceId) await requireTeamBuyer(client, workspaceId);
  const result = parseWire(
    catalog,
    await client.call(commerce + '/ItemQuery/querySubscriptionItems', {
      product: 13,
      ...(workspaceId ? { scene: 'enterprise' } : {}),
      ...(!workspaceId && !client.config.locale.toLowerCase().startsWith('zh') ? { locale: 'zh-TW' } : {}),
    }),
  );
  return result.items
    .filter((item) => item.currency === 'CNY' && result.currency === 'CNY')
    .flatMap((item) =>
      item.prices
        .filter((p) => p.unit?.trim() && !p.tags?.includes('custom') && p.rawPrice > 0)
        .map((p) => ({
          itemId: item.itemId,
          skuId: p.skuId,
          title: item.title,
          unit: p.unit,
          description: p.title ?? '',
          currency: 'CNY',
          totalMinor: p.rawPrice,
          priceText: `¥${(p.rawPrice / 100).toFixed(2)}`,
        })),
    );
}

export async function quoteSelection(client: ApiClient, selected: Selection, workspaceId?: string) {
  const product = (await fixedProducts(client, workspaceId)).find(
    (p) => p.itemId === selected.itemId && p.skuId === selected.skuId,
  );
  if (!product || selected.num !== 1)
    throw new CliError('INVALID_ARGUMENT', '请选择当前付款账户商品目录中的固定档位，每单一份。');
  const result = parseWire(
    preview,
    await client.call(commerce + '/OrderCommand/previewOrder', { items: [selected] }),
  );
  const line = result.items[0];
  if (
    result.items.length !== 1 ||
    !line ||
    line.itemId !== selected.itemId ||
    line.skuId !== selected.skuId ||
    line.num !== selected.num ||
    line.total !== result.total ||
    result.total !== product.totalMinor
  )
    throw new CliError('STALE_INTERACTION', '报价与当前商品不一致，请重新查询商品。');
  return { product, bookKey: result.bookKey };
}

export async function submitOrder(
  client: ApiClient,
  selected: Selection,
  bookKey: string,
  workspaceId?: string,
) {
  const raw = await client.call(
    commerce + '/OrderCommand/createOrder',
    { bookKey, items: [selected], ...(workspaceId ? { workspaceId } : {}) },
    true,
  );
  const result = z.object({ orderNo: orderNumber, cluster: z.string().nullish() }).safeParse(raw);
  if (!result.success) throw new CliError('OUTCOME_UNKNOWN', '下单回执不完整，请使用原购买确认命令核对。');
  return result.data;
}

/** pageOrder 按当前用户和组织过滤，详情接口本身仅验证组织。 */
export async function findOwnedOrder(client: ApiClient, match: { orderNo: string } | { bookKey: string }) {
  const size = 100;
  for (let page = 1; ; page++) {
    const data = parseWire(
      ownedPage,
      await client.call(commerce + '/OrderQuery/pageOrder', { page, pageSize: size }),
    );
    const found = data.items.find(({ orderInfo }) =>
      'orderNo' in match ? orderInfo.orderNo === match.orderNo : orderInfo.bookKey === match.bookKey,
    );
    if (found) return found.orderInfo.orderNo;
    if (data.items.length === 0 || page * size >= data.total) return undefined;
  }
}

export async function orderDetail(client: ApiClient, orderNo: string) {
  // ownerId 在订单详情中可能是 JSON 数字；在转换为 JS Number 丢失精度前保留原始整数。
  const response = await client.request(
    commerce + '/OrderQuery/queryOrderDetail',
    { orderNo },
    {
      jsonReviver(key, value, context) {
        // 主站可能已将超长 Long 饱和到这个整数，此时原始团队 ID 已不可读。
        if (key === 'ownerId' && context?.source === String(Number.MAX_SAFE_INTEGER))
          return Number.MAX_SAFE_INTEGER;
        if (key === 'ownerId' && typeof value === 'number' && context?.source && /^\d+$/.test(context.source))
          return context.source;
        return value;
      },
    },
  );
  const data = parseWire(detail, response.data);
  if (data.orderInfo.orderNo !== orderNo) throw new CliError('PROTOCOL_ERROR', '订单详情与目标订单号不符。');
  return data;
}
export function matchesOrderItem(items: unknown[] | null | undefined, expected: Selection) {
  if (items?.length !== 1) return false;
  const line = z.object(selection).safeParse(items[0]);
  return (
    line.success &&
    line.data.itemId === expected.itemId &&
    line.data.skuId === expected.skuId &&
    line.data.num === expected.num
  );
}

export function orderStatus(data: Awaited<ReturnType<typeof orderDetail>>, confirmedWorkspaceId?: string) {
  const { orderNo, status, total, currencyCode, extra } = data.orderInfo;
  const state = states.get(status) ?? 'UNKNOWN';
  const ownerId = extra?.ownerId;
  const workspaceId =
    ownerId === Number.MAX_SAFE_INTEGER
      ? confirmedWorkspaceId
      : typeof ownerId === 'string' || Number.isSafeInteger(ownerId)
        ? String(ownerId)
        : undefined;
  let balanceCommand: string[] | undefined;
  if ((status === 20 || status === 50) && extra?.product === 13) {
    if (extra.ownerType === 'user') balanceCommand = ['superun-ai', 'bill', 'balance'];
    if (extra.ownerType === 'workspace' && workspaceId && /^[1-9]\d*$/.test(workspaceId))
      balanceCommand = ['superun-ai', 'bill', 'balance', '--workspace-id', workspaceId];
  }
  return {
    orderNo,
    status,
    state,
    message:
      (
        {
          PAID: '支付成功。',
          COMPLETED: '订单已完成。',
          CLOSED: '订单已关闭。',
          CANCELLED: '订单已取消。',
          WAIT_PAYMENT: '订单待支付。',
          INITIALIZING: '订单初始化中。',
        } as Record<string, string>
      )[state] ?? '服务端返回了未知订单状态。',
    totalMinor: total,
    currency: currencyCode,
    ...(balanceCommand ? { balanceCommand } : {}),
  };
}
