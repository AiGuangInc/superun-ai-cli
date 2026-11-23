/** 按凭据和本次确认持久化下单意图，避免并发或重试产生重复订单。@author xiuyu.yi */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { stateDirectory } from '../config/state-directory.js';
import { InteractionDraftStore } from '../interactions/draft-store.js';
import { CliError } from '../output/exit-codes.js';
import type { ApiClient } from '../transport/api-client.js';
import {
  findOwnedOrder,
  orderDetail,
  matchesOrderItem,
  orderNumber,
  orderStatus,
  quoteSelection,
  submitOrder,
  requireTeamBuyer,
  type Selection,
} from './purchase-api.js';

const intentSchema = z.object({
  state: z.enum(['QUOTED', 'SUBMITTING', 'CREATED', 'REJECTED']),
  rejectionCode: z.number().int().optional(),
  itemId: z.number().int().positive(),
  skuId: z.number().int().positive(),
  num: z.literal(1),
  workspaceId: z.string().optional(),
  totalMinor: z.number().int().positive(),
  unit: z.string(),
  title: z.string(),
  description: z.string(),
  bookKey: z.string().min(1),
  orderNo: orderNumber.optional(),
  cluster: z.string().nullish(),
});

// 只收录 Center 明确的下单校验/事务回滚错误。重复 bookKey 仍须查找原单。
const rejectionMessages = new Map([
  [200000005, '商品不存在或购买数量超出范围。'],
  [200000006, '所选档位不存在。'],
  [200000007, '所选档位库存不足。'],
  [200000008, '订单商品币种不一致。'],
  [600050002, '目标团队已不存在或不可用，请重新选择团队。'],
]);

function rejectedOrder(code: number) {
  return new CliError(
    'BUSINESS_ERROR',
    (rejectionMessages.get(code) ?? '下单被拒绝。') + '请重新查询商品并报价。',
    { businessCode: code },
  );
}

function confirmArgs(selected: Selection, id: string, amount: number, workspaceId?: string) {
  return [
    'superun-ai',
    'order',
    'create',
    '--item-id',
    String(selected.itemId),
    '--sku-id',
    String(selected.skuId),
    ...(workspaceId ? ['--workspace-id', workspaceId] : []),
    '--purchase-id',
    id,
    '--confirm-total-minor',
    String(amount),
    '--currency',
    'CNY',
  ];
}

export class PurchaseIntent {
  private readonly store: InteractionDraftStore;
  constructor(private readonly client: ApiClient) {
    this.store = new InteractionDraftStore(client.interactionScope, join(stateDirectory(), 'purchases'));
  }

  /** 本机确认过的购买记录可用于补全原单的余额查询命令。 */
  async status(result: Awaited<ReturnType<typeof orderDetail>>) {
    const info = result.orderInfo;
    if (
      info.extra?.ownerId !== Number.MAX_SAFE_INTEGER ||
      info.extra.ownerType !== 'workspace' ||
      (info.status !== 20 && info.status !== 50)
    )
      return orderStatus(result);
    const key = await this.store.read('order:' + info.orderNo);
    if (typeof key !== 'string') return orderStatus(result);
    const saved = intentSchema.safeParse(await this.store.read(key));
    const original = saved.success ? saved.data : undefined;
    if (
      !original?.workspaceId ||
      original.state !== 'CREATED' ||
      original.orderNo !== info.orderNo ||
      !info.bookKey ||
      original.bookKey !== info.bookKey ||
      !matchesOrderItem(result.orderItems, original)
    )
      return orderStatus(result);
    return orderStatus(result, original.workspaceId);
  }

  async prepare(selected: Selection, workspaceId?: string) {
    const { product, bookKey } = await quoteSelection(this.client, selected, workspaceId);
    const purchaseId = randomUUID();
    await this.store.write(purchaseId, {
      ...selected,
      workspaceId,
      totalMinor: product.totalMinor,
      unit: product.unit,
      title: product.title,
      description: product.description,
      bookKey,
      state: 'QUOTED',
    });
    return {
      state: 'AWAITING_CONFIRMATION',
      scope: workspaceId ? 'workspace' : 'personal',
      ...(workspaceId ? { workspaceId } : {}),
      purchaseId,
      ...product,
      quantity: selected.num,
      message: '请确认付款账户、商品权益、币种和应付金额后再提交。',
      confirmCommand: confirmArgs(selected, purchaseId, product.totalMinor, workspaceId),
    };
  }

  async confirm(selected: Selection, purchaseId: string, totalMinor: number, workspaceId?: string) {
    let orderNo: string | undefined;
    const confirmation = this.store.locked(purchaseId, async () => {
      const parsed = intentSchema.safeParse(await this.store.read(purchaseId));
      if (!parsed.success) throw new CliError('INVALID_ARGUMENT', '当前账号没有可恢复的购买确认记录。');
      const intent = parsed.data;
      if (
        intent.workspaceId !== workspaceId ||
        intent.itemId !== selected.itemId ||
        intent.skuId !== selected.skuId ||
        intent.num !== selected.num
      )
        throw new CliError('INVALID_ARGUMENT', '确认记录与指定付款账户或商品不一致。');
      if (intent.state === 'REJECTED') {
        if (intent.rejectionCode === undefined)
          throw new CliError('PROTOCOL_ERROR', '拒单记录缺少业务码，请重新查询商品。');
        throw rejectedOrder(intent.rejectionCode);
      }
      orderNo = intent.orderNo;
      if (intent.state === 'QUOTED') {
        const latest = await quoteSelection(this.client, selected, workspaceId);
        if (
          totalMinor !== intent.totalMinor ||
          totalMinor !== latest.product.totalMinor ||
          latest.product.unit !== intent.unit ||
          latest.product.title !== intent.title ||
          latest.product.description !== intent.description
        )
          throw new CliError('STALE_INTERACTION', '商品权益、价格或确认金额已变化，请重新取得报价并确认。');
        // 用提交时的目标团队权限复核，权限失败仍保留未提交的报价。
        if (workspaceId) await requireTeamBuyer(this.client, workspaceId);
        await this.store.write(purchaseId, { ...intent, state: 'SUBMITTING' });
        // 提交标记先落盘；即使进程在回执前退出，下次也只恢复原单。
        const created = await submitOrder(this.client, selected, intent.bookKey, workspaceId).catch(
          async (error: unknown) => {
            if (error instanceof CliError) {
              if (error.code === 'AUTH_REQUIRED') {
                // 明确的鉴权拒绝未创建订单；恢复权限后仍需重新校验报价再提交。
                await this.store.write(purchaseId, intent);
                throw error;
              }
              const code = Number(error.details.businessCode);
              if (error.code === 'BUSINESS_ERROR' && rejectionMessages.has(code)) {
                await this.store.write(purchaseId, { ...intent, state: 'REJECTED', rejectionCode: code });
                throw rejectedOrder(code);
              }
            }
            throw new CliError(
              'OUTCOME_UNKNOWN',
              '创建结果待核对，请保留本次购买确认号并使用原确认命令恢复。',
              { purchaseId, retryable: false },
            );
          },
        );
        orderNo = created.orderNo;
        await this.store.write(purchaseId, { ...intent, state: 'CREATED', ...created });
        intent.cluster = created.cluster;
      } else {
        if (workspaceId) await requireTeamBuyer(this.client, workspaceId);
        if (!orderNo) {
          orderNo = await findOwnedOrder(this.client, { bookKey: intent.bookKey });
          if (!orderNo)
            throw new CliError('OUTCOME_UNKNOWN', '原购买请求结果待核对，勿重复下单。', {
              purchaseId,
              retryable: false,
            });
          await this.store.write(purchaseId, { ...intent, state: 'CREATED', orderNo });
        }
      }
      if (!orderNo)
        throw new CliError('OUTCOME_UNKNOWN', '缺少原订单号，请使用原确认命令恢复。', { purchaseId });
      const result = await orderDetail(this.client, orderNo).catch((error: unknown) => {
        if (error instanceof CliError)
          throw new CliError(error.code, '已取得订单号，暂时无法核对详情，请查询原单。', {
            ...error.details,
            orderNo,
            purchaseId,
            statusCommand: ['superun-ai', 'order', 'status', orderNo],
          });
        throw error;
      });
      // 详情只有明确的数字饱和值时，使用原购买记录绑定的团队。后续还须核对本人订单与原 bookKey。
      const ownerId = result.orderInfo.extra?.ownerId;
      const clampedTeam =
        workspaceId !== undefined &&
        ownerId === Number.MAX_SAFE_INTEGER &&
        BigInt(workspaceId) >= BigInt(Number.MAX_SAFE_INTEGER);
      if (
        result.orderInfo.bookKey !== intent.bookKey ||
        result.orderInfo.currencyCode !== 'CNY' ||
        result.orderInfo.extra?.ownerType !== (workspaceId ? 'workspace' : 'user') ||
        (workspaceId !== undefined && ownerId !== workspaceId && !clampedTeam) ||
        result.orderInfo.extra?.product !== 13 ||
        !matchesOrderItem(result.orderItems, selected)
      )
        throw new CliError('PROTOCOL_ERROR', '订单归属或商品与购买确认不一致，请核对原单。', { orderNo });
      if (clampedTeam && workspaceId) {
        const ownedOrderNo = await findOwnedOrder(this.client, { bookKey: intent.bookKey });
        if (ownedOrderNo !== orderNo)
          throw new CliError('PROTOCOL_ERROR', '无法核实原购买记录对应的本人订单。', { orderNo });
        await requireTeamBuyer(this.client, workspaceId);
        await this.store.write('order:' + orderNo, purchaseId);
      }
      const status = orderStatus(result, workspaceId);
      const account = workspaceId ? { scope: 'workspace', workspaceId } : { scope: 'personal' };
      if (status.state !== 'WAIT_PAYMENT') return { ...status, ...account };
      if (status.totalMinor !== totalMinor)
        return {
          ...status,
          state: 'PRICE_CHANGED',
          ...account,
          purchaseId,
          message: '订单实际金额与确认金额不同，请确认新的应付额。',
          confirmCommand: confirmArgs(selected, purchaseId, status.totalMinor, workspaceId),
        };
      if (intent.cluster && intent.cluster !== 'superun.com')
        throw new CliError('PROTOCOL_ERROR', '订单回执站点不匹配，无法打开收银台。', { orderNo });
      const url = new URL('https://pay.superun.com/web/orders/pay');
      url.search = new URLSearchParams({
        orderNo: status.orderNo,
        cluster: 'superun.com',
        source: 'superun',
        ...(workspaceId ? { showTransfer: '1' } : {}),
      }).toString();
      return {
        ...status,
        ...account,
        purchaseId,
        checkoutUrl: url.href,
        message: `订单已创建，待支付 ¥${(status.totalMinor / 100).toFixed(2)}。请用下单账号打开官方收银台：${url.href}`,
        waitCommand: ['superun-ai', 'order', 'wait', status.orderNo],
      };
    });
    return confirmation.catch((error: unknown) => {
      // 创建、恢复及清理本地状态都可能失败；已取得的原订单号仍可用于独立查单。
      if (orderNo && error instanceof CliError && error.code.startsWith('LOCAL_STATE_')) {
        throw new CliError(error.code, '订单已创建，本地状态保存或清理失败，请按订单号核对原单。', {
          ...error.details,
          purchaseId,
          orderNo,
          statusCommand: ['superun-ai', 'order', 'status', orderNo],
          retryable: false,
        });
      }
      throw error;
    });
  }
}
