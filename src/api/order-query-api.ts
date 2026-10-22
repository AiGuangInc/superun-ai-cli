/** 当前登录用户的购买订单查询，只保留展示所需字段。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';

const amount = z.number().int().safe().nullish();
const timestamp = z.number().int().safe().nullish();
const optionalText = z.string().nullish();
const orderPageSchema = z.object({
  total: z.number().int().nonnegative().safe(),
  items: z.array(
    z.object({
      orderInfo: z.object({
        orderNo: z.string().min(1),
        status: z.number().int().safe().nullish(),
        currencyCode: optionalText,
        subtotal: amount,
        discount: amount,
        total: amount,
        createdAt: timestamp,
        bookedAt: timestamp,
        paidAt: timestamp,
        cancelledAt: timestamp,
        expiringAt: timestamp,
        invoiceStatus: z.number().int().safe().nullish(),
        invoiceAppliedAt: timestamp,
        invoiceDownloadUrl: optionalText,
        invoiceOfdUrl: optionalText,
        latestEffectiveInvoice: z
          .object({
            invoiceCode: optionalText,
            invoiceNum: optionalText,
            invoiceDate: timestamp,
            currencyCode: optionalText,
            invoiceAmount: amount,
          })
          .nullish(),
      }),
      orderItems: z.array(
        z.object({
          title: optionalText,
          num: z.number().int().safe().nullish(),
          skuProperty: z.array(z.object({ k: optionalText, v: optionalText })).nullish(),
          unitPrice: amount,
          subTotal: amount,
          total: amount,
        }),
      ),
    }),
  ),
});

const ORDER_STATUS_NAMES: Record<number, string> = {
  0: '初始化',
  10: '待支付',
  20: '已支付',
  50: '已完成',
  60: '已关闭',
  70: '已取消',
};
const INVOICE_STATUS_NAMES: Record<number, string> = {
  0: '未开票',
  1: '已申请',
  2: '开票成功',
  3: '开票中',
  4: '开票失败',
  5: '调整中',
  6: '已全额红冲',
};

function statusName(code: number | null | undefined, names: Record<number, string>): string {
  return code == null ? '未返回状态' : (names[code] ?? `未知状态（${code}）`);
}

export class OrderQueryApi {
  constructor(private readonly client: ApiClient) {}

  async page(page: number, pageSize: number, status?: number) {
    const result = parseWire(
      orderPageSchema,
      await this.client.call('/api/uxa-center/ecommerce/OrderQuery/pageOrder', {
        page,
        pageSize,
        ...(status === undefined ? {} : { status }),
      }),
    );
    if (result.items.length > pageSize || result.items.length > result.total)
      throw new CliError('PROTOCOL_ERROR', '订单分页返回的数量与页大小或总数不一致');
    if (status !== undefined && result.items.some((item) => item.orderInfo.status !== status))
      throw new CliError('PROTOCOL_ERROR', '订单返回状态与本次筛选条件不一致');
    return {
      total: result.total,
      // Zod 在每层对象剔除未声明字段，避免透出身份、支付对象和完整发票资料。
      items: result.items.map((item) => ({
        ...item,
        orderInfo: {
          ...item.orderInfo,
          statusName: statusName(item.orderInfo.status, ORDER_STATUS_NAMES),
          invoiceStatusName: statusName(item.orderInfo.invoiceStatus, INVOICE_STATUS_NAMES),
        },
      })),
    };
  }
}
