/** Parallel 多批次结果映射为稳定候选 ID。@author xiuyu.yi */
import { enabled, list, object, text } from '../../contracts/value.js';
import type { SessionView } from '../../contracts/node-wire.js';
import { currentRound, roundMessage } from '../../conversation/round-selector.js';
import type { JsonObject } from '../../contracts/value.js';
import type { Choice } from '../../contracts/cli-output.js';
import { CliError } from '../../output/exit-codes.js';
import { DEFAULT_ENDPOINT } from '../../config/constants.js';
import { getSuperunHostingDomain } from '../../config/runtime-config.js';

export type StyleWaitTarget = { preReplyMessageId: string; choiceIds: Array<string> };

/** 根据本次并行创建响应固定等待目标，不能用历史批次替代。 */
export function styleWaitTarget(response: JsonObject): StyleWaitTarget | undefined {
  if (!Array.isArray(response.items)) return undefined;
  const anchor = text(response.preReplyMessageId);
  const ids = response.items.map((item) => text(object(item).replyMessageId));
  if (!anchor || !ids.length || ids.some((id) => !id) || new Set(ids).size !== ids.length)
    throw new CliError('OUTCOME_UNKNOWN', '风格请求已返回，但缺少本批候选标识；请查询后确认，勿重复生成', {
      sessionId: text(response.sessionId),
    });
  return { preReplyMessageId: anchor, choiceIds: ids.filter((id): id is string => !!id) };
}

/** 普通状态查询只判断最新批次，历史失败/运行记录不阻塞新批次。 */
export function latestStyleChoices(choices: Array<Choice>): Array<Choice> {
  const version = Math.max(...choices.map((choice) => choice.batchVersion ?? 0));
  return choices.filter((choice) => (choice.batchVersion ?? 0) === version);
}

/** 只有成功状态与预览页面同时就绪，才向用户报告方案已生成。 */
export function readyStyleChoices(choices: Array<Choice>): Array<Choice> {
  return latestStyleChoices(choices).filter(
    (choice) => choice.status === 'success' && !!choice.previewUrl && !choice.errorType && !choice.selected,
  );
}

/** 方案编号跟随原始 index，不随异步完成顺序变化。 */
export function styleChoiceLabel(choice: Pick<Choice, 'index'>): string {
  return `方案 ${String.fromCharCode(65 + choice.index)}`;
}

export function isStyleSelected(view: SessionView, choices: Array<Choice> = []): boolean {
  const flag = roundMessage(view, currentRound(view))?.roundExtra?.hasSelectedStyle;
  // 当前轮明确回到未选态时，不能被旧批次的已选记录覆盖。
  return flag !== undefined ? enabled(flag) : latestStyleChoices(choices).some((choice) => choice.selected);
}

export function styleBranchAnchor(view: SessionView): string | undefined {
  if (view.session.pendingBranch) return view.session.pendingBranch.preReplyMessageId;
  if (!isStyleSelected(view)) return undefined;
  // 选择成功后未决标记会被清除，已选批次仍可通过主链风格卡的真实锚点查询。
  return (view.pipeline.render?.rounds ?? [])
    .filter((round) => !round.meta?.consult && !round.meta?.passive && !round.meta?.subAgentReport)
    .sort((a, b) => b.time.timestamp - a.time.timestamp)
    .find((round) => round.agentItems.some((item) => item.kind === 'card' && item.variant === 'style_card'))
    ?.anchorUserMessageId;
}

export function styleBatchState(
  choices: Array<Choice>,
): 'RUNNING' | 'NEEDS_SELECTION' | 'FAILED' | 'COMPLETED' {
  if (choices.some((choice) => choice.selected)) return 'COMPLETED';
  if (
    !choices.length ||
    choices.some(
      (choice) => choice.status === 'running' || (choice.status === 'success' && !choice.previewUrl),
    )
  )
    return 'RUNNING';
  return choices.some((choice) => choice.status === 'success') ? 'NEEDS_SELECTION' : 'FAILED';
}

/** 与 Glow 的分支 iframe 同源，snapshotUrl 是图片，snapshotId 才用于生成页面地址。 */
function stylePreviewUrl(item: JsonObject, endpoint: string): string | undefined {
  const snapshotId =
    typeof item.snapshotId === 'number' && Number.isSafeInteger(item.snapshotId) && item.snapshotId > 0
      ? String(item.snapshotId)
      : text(item.snapshotId)?.trim();
  if (!snapshotId || !/^[a-zA-Z0-9_-]+$/.test(snapshotId)) return undefined;
  const url = new URL(`https://snapshot--${snapshotId}.${getSuperunHostingDomain(endpoint)}`);
  if (
    typeof item.updateTimestamp === 'number' &&
    Number.isSafeInteger(item.updateTimestamp) &&
    item.updateTimestamp > 0
  )
    url.searchParams.set('t', String(item.updateTimestamp));
  return url.toString();
}

export function projectChoices(
  response: unknown,
  anchor: string,
  endpoint = DEFAULT_ENDPOINT,
): Array<Choice> {
  return list(object(response).items).flatMap((batch) => {
    const entry = object(batch);
    const info = object(entry.parallelInfo);
    return list(info.items).map((value) => {
      const item = object(value);
      const reply = text(item.replyMessageId);
      if (!reply || typeof item.index !== 'number')
        throw new CliError('PROTOCOL_ERROR', '风格候选缺少稳定 ID');
      const errorType =
        object(item.roundExtra).finish_reason === 'content_filter' ? 'content_filter' : text(item.errorType);
      return {
        choiceId: reply,
        batchVersion: typeof entry.version === 'number' ? entry.version : undefined,
        index: item.index,
        preReplyMessageId: anchor,
        replyMessageId: reply,
        lastReplyMessageId: text(item.lastReplyMessageId),
        status:
          errorType || item.status === -1
            ? ('failed' as const)
            : item.status === 1
              ? ('success' as const)
              : ('running' as const),
        previewUrl: stylePreviewUrl(item, endpoint),
        errorType,
        selected: info.selectedReplyMessageId === reply,
      };
    });
  });
}
