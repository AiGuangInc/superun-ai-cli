/** 主站商品查询、独立创建、查单和等待支付。@author xiuyu.yi */
import { setTimeout as delay } from 'node:timers/promises';
import { InvalidArgumentError, type Command } from 'commander';
import { z } from 'zod';
import { findOwnedOrder, fixedProducts, orderDetail, orderNumber } from '../../api/purchase-api.js';
import { PurchaseIntent } from '../../api/purchase-intent.js';
import { CliError } from '../../output/exit-codes.js';
import type { ApiClient } from '../../transport/api-client.js';
import { positive, runtime, type CommandContext } from '../shared.js';

function workspace(value: string) {
  if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new InvalidArgumentError('团队 ID 必须是有效的正整数。');
  return value;
}
function orderNoArg(value: string) {
  if (!orderNumber.safeParse(value).success) throw new InvalidArgumentError('订单号格式不正确。');
  return value;
}

export function registerProduct(program: Command, context: CommandContext) {
  program
    .command('product')
    .description('查询主站可购买的固定算力套餐')
    .command('list')
    .description('查询个人或管理团队的商品与价格')
    .option('--workspace-id <id>', '目标团队 ID', workspace)
    .action(async (options: { workspaceId?: string }, command: Command) => {
      const { client } = await runtime(context, command);
      const items = await fixedProducts(client, options.workspaceId);
      context.output.write({
        state: 'COMPLETED',
        scope: options.workspaceId ? 'workspace' : 'personal',
        workspaceId: options.workspaceId ?? null,
        amountUnit: 'minor',
        items: items.map((item) => ({
          ...item,
          quoteCommand: [
            'superun-ai',
            'order',
            'create',
            '--item-id',
            String(item.itemId),
            '--sku-id',
            String(item.skuId),
            ...(options.workspaceId ? ['--workspace-id', options.workspaceId] : []),
          ],
        })),
        message: items.length
          ? '请选择档位，执行对应的报价命令，确认金额后下单。'
          : '当前没有可购买的固定算力套餐。',
      });
    });
}

async function verifyOwnOrder(client: ApiClient, orderNo: string) {
  if (!(await findOwnedOrder(client, { orderNo })))
    throw new CliError('AUTH_REQUIRED', '当前账号无法查询该订单。', { authFailure: 'ACCESS_DENIED' });
}

export function registerPurchaseOrders(order: Command, context: CommandContext) {
  order
    .command('create')
    .description('获取主站固定套餐报价，明确确认后创建个人或管理团队订单')
    .requiredOption('--item-id <id>', '商品 ID', positive)
    .requiredOption('--sku-id <id>', '档位 ID', positive)
    .option('--quantity <count>', '固定套餐每次一份', positive, 1)
    .option('--workspace-id <id>', '目标团队 ID', workspace)
    .option('--purchase-id <id>', '本次报价回执的购买确认号')
    .option('--confirm-total-minor <amount>', '已确认的应付金额（分）', positive)
    .option('--currency <code>', '已确认的币种 CNY')
    .action(
      async (
        options: {
          itemId: number;
          skuId: number;
          quantity: number;
          workspaceId?: string;
          purchaseId?: string;
          confirmTotalMinor?: number;
          currency?: string;
        },
        command: Command,
      ) => {
        const { client } = await runtime(context, command);
        const selected = { itemId: options.itemId, skuId: options.skuId, num: options.quantity };
        if (options.quantity !== 1) throw new CliError('INVALID_ARGUMENT', '固定算力套餐每单购买一份。');
        const intent = new PurchaseIntent(client);
        if (
          options.purchaseId === undefined &&
          options.confirmTotalMinor === undefined &&
          options.currency === undefined
        ) {
          context.output.write(await intent.prepare(selected, options.workspaceId));
          return;
        }
        if (
          !options.purchaseId ||
          !z.string().uuid().safeParse(options.purchaseId).success ||
          options.confirmTotalMinor === undefined ||
          options.currency !== 'CNY'
        )
          throw new CliError('INVALID_ARGUMENT', '请使用原报价的购买确认号、确认金额和币种 CNY。');
        context.output.write(
          await intent.confirm(selected, options.purchaseId, options.confirmTotalMinor, options.workspaceId),
        );
      },
    );
  order
    .command('status <orderNo>')
    .description('查询本人指定订单的支付状态')
    .action(async (raw: string, _options: unknown, command: Command) => {
      const orderNo = orderNoArg(raw);
      const { client } = await runtime(context, command);
      await verifyOwnOrder(client, orderNo);
      context.output.write(await new PurchaseIntent(client).status(await orderDetail(client, orderNo)));
    });
  order
    .command('wait <orderNo>')
    .description('等待本人指定订单的支付结果')
    .option('--timeout <seconds>', '本地等待秒数', positive, 300)
    .action(async (raw: string, options: { timeout: number }, command: Command) => {
      const orderNo = orderNoArg(raw);
      if (options.timeout > 2147483) throw new CliError('INVALID_ARGUMENT', '等待时间过长。');
      const { client } = await runtime(context, command);
      const timeout = AbortSignal.timeout(options.timeout * 1000);
      const signal = AbortSignal.any([context.signal, timeout]);
      const reader = client.withSignal(signal);
      try {
        await verifyOwnOrder(reader, orderNo);
        const purchase = new PurchaseIntent(reader);
        for (;;) {
          const status = await purchase.status(await orderDetail(reader, orderNo));
          if (status.state !== 'INITIALIZING' && status.state !== 'WAIT_PAYMENT') {
            context.output.write(status);
            return;
          }
          await delay(5000, undefined, { signal });
        }
      } catch (error) {
        if (context.signal.aborted)
          throw new CliError('INTERRUPTED', '已停止等待，订单状态可继续查询。', { orderNo });
        if (timeout.aborted)
          throw new CliError('LOCAL_WAIT_TIMEOUT', '本地等待超时，可继续查询同一订单。', {
            orderNo,
            waitCommand: ['superun-ai', 'order', 'wait', orderNo],
          });
        throw error;
      }
    });
}
