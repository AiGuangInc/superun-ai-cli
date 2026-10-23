/** 当前主线发布准备与费用确认绑定。@author xiuyu.yi */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';
import { projectCheckPreflight } from './project-check-preflight.js';

const amount = z.number().int().nonnegative().safe();
const candidateSchema = z.object({
  encryptedId: z.string().min(1),
  updatedAt: amount,
  deployStatus: z.number().int(),
  changeLog: z.string().nullish(),
  changeLogSummary: z.string().nullish(),
  websiteIntroduction: z.string().nullish(),
});
const feeSchema = z.object({
  costItems: z.array(z.object({ name: z.string().min(1), estimatedDailyCost: amount })),
  estimatedDailyTotal: amount,
  estimatedMonthlyTotal: amount,
});

export async function preparePublish(service: CreationRuntime, sessionId: string) {
  const view = await service.load(sessionId);
  const gate = await projectCheckPreflight(service, view, sessionId, '发布当前主线');
  if (gate.hasStaging)
    throw new CliError(
      'INVALID_ARGUMENT',
      '当前有未合并的源码暂存，请先确认合并或放弃暂存，再发布当前主线；不会自动合并',
      { sessionId },
    );
  if (gate.stage !== 'development')
    throw new CliError('INVALID_ARGUMENT', '当前仍是演示阶段，本入口只发布研发主线；不会自动进入研发', {
      sessionId,
    });
  const status = parseWire(
    z.object({
      unPublishedVersion: candidateSchema.nullish(),
      publishUrl: z.string().url().nullish(),
      targetRegion: z.string().nullish(),
      deploymentNode: z.string().nullish(),
    }),
    await service.publish.status(sessionId),
  );
  if (!['CN', 'INTL'].includes(status.targetRegion ?? ''))
    throw new CliError('PROTOCOL_ERROR', '当前发布区域无法明确确认，请先核对项目发布配置');
  const candidate = status.unPublishedVersion;
  if (!candidate || candidate.deployStatus !== 0)
    throw new CliError(
      'INVALID_ARGUMENT',
      candidate?.deployStatus === 2
        ? '已有发布正在进行，请继续跟踪同一记录，勿重复发布'
        : '当前没有可发布的待发布记录，请先在原项目完成当前改动',
      { sessionId, encryptedId: candidate?.encryptedId },
    );
  if (view.session.publicStatus !== 0 && view.session.publicStatus !== 1)
    throw new CliError('PROTOCOL_ERROR', '当前站点公开状态未知，请先核对再准备发布');
  if (!status.publishUrl) throw new CliError('PROTOCOL_ERROR', '尚未取得正式访问地址，请先核对项目发布配置');
  if (status.publishUrl) {
    const url = new URL(status.publishUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new CliError('PROTOCOL_ERROR', '正式访问地址不符合安全链接格式，未继续发布');
  }
  const rawFee = parseWire(feeSchema, await service.publish.preflightCost(sessionId));
  const costItems = [...rawFee.costItems].sort(
    (a, b) => a.name.localeCompare(b.name) || a.estimatedDailyCost - b.estimatedDailyCost,
  );
  const itemizedDailyTotal = costItems.reduce((total, item) => total + item.estimatedDailyCost, 0);
  if (!Number.isSafeInteger(itemizedDailyTotal * 30))
    throw new CliError('PROTOCOL_ERROR', '费用估算超出支持范围');
  const fee = {
    ...rawFee,
    costItems,
    itemizedDailyTotal,
    itemizedThirtyDayTotal: itemizedDailyTotal * 30,
    currency: 'GLOW_TOKEN',
    unitsPerToken: 100,
    totalsConsistent:
      rawFee.estimatedDailyTotal === itemizedDailyTotal &&
      rawFee.estimatedMonthlyTotal === itemizedDailyTotal * 30,
    confirmationRequired:
      itemizedDailyTotal > 0 || rawFee.estimatedDailyTotal > 0 || rawFee.estimatedMonthlyTotal > 0,
  };
  const quoteId = createHash('sha256')
    .update(
      JSON.stringify({
        sessionId,
        sourceMessageId: gate.sourceMessageId,
        candidate,
        fee,
        targetRegion: status.targetRegion,
        deploymentNode: status.deploymentNode,
        publishUrl: status.publishUrl,
        publicStatus: view.session.publicStatus,
      }),
    )
    .digest('hex');
  return {
    state: 'READY',
    sessionId,
    topic: view.session.topic,
    sourceMessageId: gate.sourceMessageId,
    stage: gate.stage,
    publicStatus: view.session.publicStatus,
    publishUrl: status.publishUrl,
    targetRegion: status.targetRegion,
    deploymentNode: status.deploymentNode,
    candidate,
    fee,
    quoteId,
    sourcePolicy: 'CURRENT_MAINLINE_ONLY',
    warning: fee.totalsConsistent
      ? undefined
      : '服务端汇总与费用明细不一致，请展示两者及差额，不称免费；实际计费须核实。',
  };
}

export function assertPublishConfirmation(
  prepared: Awaited<ReturnType<typeof preparePublish>>,
  encryptedId: string,
  sourceMessageId: unknown,
  quoteId: unknown,
  acknowledged: boolean,
) {
  if (
    prepared.candidate.encryptedId !== encryptedId ||
    prepared.sourceMessageId !== sourceMessageId ||
    prepared.quoteId !== quoteId
  )
    throw new CliError('STALE_INTERACTION', '当前主线、待发布记录或费用估算已变化，请重新准备并确认', {
      sessionId: prepared.sessionId,
    });
  if (prepared.fee.confirmationRequired && !acknowledged)
    throw new CliError(
      'INVALID_ARGUMENT',
      '本次发布存在云服务费用估算，请取得用户对当前目标和费用的明确确认后继续',
      { preparation: prepared },
    );
}
