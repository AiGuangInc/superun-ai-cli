/** Parallel 多批次结果映射为稳定候选 ID。@author xiuyu.yi */
import { enabled, list, object, text } from '../../contracts/value.js';
import type { SessionView } from '../../contracts/node-wire.js';
import { currentRound, roundMessage } from '../../conversation/round-selector.js';
import type { JsonObject } from '../../contracts/value.js';
import type { Choice } from '../../contracts/cli-output.js';
import { CliError } from '../../output/exit-codes.js';

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
      (choice) => choice.status === 'running' || (choice.status === 'success' && !choice.screenshotUrl),
    )
  )
    return 'RUNNING';
  return choices.some((choice) => choice.status === 'success') ? 'NEEDS_SELECTION' : 'FAILED';
}

export function projectChoices(response: unknown, anchor: string): Array<Choice> {
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
        // 风格阶段只返回截图，不推导页面快照链接。
        screenshotUrl: text(item.snapshotUrl)?.trim() || undefined,
        errorType,
        selected: info.selectedReplyMessageId === reply,
      };
    });
  });
}
