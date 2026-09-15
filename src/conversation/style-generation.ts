/** 与 Glow 共用风格批次、免费额度与失败重试契约。@author xiuyu.yi */
import type { CreationRuntime } from '../runtime.js';
import type { Choice } from '../contracts/cli-output.js';
import { list, object, text } from '../contracts/value.js';
import type { JsonObject } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { currentRound } from './round-selector.js';
import {
  isStyleSelected,
  projectChoices,
  readyStyleChoices,
  styleChoiceLabel,
  styleWaitTarget,
} from '../interactions/parsers/style-selection.js';

export const APPEND_STYLE_OPTION =
  '**再设计一版**：委托高级设计师生成更多方案，预计消耗 **50～100 算力值**，按实际用量扣费。';
export const APPEND_STYLE_NOTICE =
  '高级设计师已接受委托，正在根据你的需求定制一版新方案，完成后按实际用量扣费（预计 50–100 算力值），这可能需要一些时间。';

export function existingStyleLinks(choices: Array<Choice>): string {
  return readyStyleChoices(choices)
    .sort((a, b) => a.index - b.index)
    .map(
      (choice) =>
        `已有${styleChoiceLabel(choice)} 仍可查看：[查看${styleChoiceLabel(choice)}](${choice.previewUrl})。`,
    )
    .join('\n');
}

/** 与 Glow 的 extractBatchUserMessageText 一样，只恢复首批 raw_input.content。 */
export function initialStyleContent(response: JsonObject): string {
  const batches = list(response.items)
    .map(object)
    .sort((a, b) => Number(a.version ?? 0) - Number(b.version ?? 0));
  const info = object(batches[0]?.parallelInfo);
  const pretty = text(object(list(object(list(object(info.prettyUserMessage).contents)[0]).blocks)[0]).text);
  if (pretty?.trim()) return pretty;
  const raw = text(object(list(object(info.userMessage).contents)[0]).content);
  try {
    const content = text(object(object(JSON.parse(raw ?? '')).raw_input).content);
    if (content?.trim()) return content;
  } catch {
    /* 没有原始需求时停止，不能拿追加要求替代首批需求。 */
  }
  throw new CliError('PROTOCOL_ERROR', '未能读取本轮已保存的需求，请查看项目详情后重试；尚未创建新方案');
}

export async function generateInitialStyles(
  runtime: CreationRuntime,
  sessionId: string,
  content: string,
  anchor?: string,
): Promise<JsonObject> {
  const view = await runtime.load(sessionId);
  if (view.extra.agentRuntime === 'shire')
    throw new CliError('INVALID_ARGUMENT', '当前处于 Stage0，请先完成进入构想阶段的交接');
  const preReplyMessageId =
    anchor ?? view.session.pendingBranch?.preReplyMessageId ?? currentRound(view)?.anchorUserMessageId;
  if (!preReplyMessageId) throw new CliError('INVALID_ARGUMENT', '未找到需求轮次，请先完成需求问卷');
  const existing = await runtime.choices(sessionId, preReplyMessageId, view);
  if (existing.length || isStyleSelected(view))
    throw new CliError('STALE_INTERACTION', '本轮已有方案，请查询后选择、重试或再设计一版，勿重复首次生成', {
      sessionId,
    });
  const response = await runtime.command.parallel({
    sessionId,
    preReplyMessageId,
    items: [{ index: 0, mode: 6, framework: 6, content, businessParams: { business_type: 'startMV' } }],
  });
  if (!styleWaitTarget(response))
    throw new CliError('OUTCOME_UNKNOWN', '生成请求已返回，但缺少方案标识，请查看进度，勿重复生成', {
      sessionId,
    });
  const notice = '需求已确认，正在为你免费生成第一个方案。';
  runtime.output.log(notice);
  try {
    await runtime.command.sessionExtra(sessionId, {
      hasClarifiedPrd: '1',
      generatedByBranch: '1',
      version: '6',
    });
  } catch {
    throw new CliError('OUTCOME_UNKNOWN', '方案生成已提交，阶段状态同步未确认，请查看进度，勿重复生成', {
      sessionId,
      preReplyMessageId,
    });
  }
  return { ...response, stylePhase: 'initial', styleNotice: notice };
}

export async function appendStyle(
  runtime: CreationRuntime,
  sessionId: string,
  anchor: string,
): Promise<JsonObject> {
  const view = await runtime.load(sessionId);
  if (view.session.pendingBranch?.preReplyMessageId !== anchor || isStyleSelected(view))
    throw new CliError('STALE_INTERACTION', '当前风格轮次已变化或已选择方案，请重新查看进度');
  const raw = await runtime.query.parallel(sessionId, anchor, true);
  const choices = projectChoices(raw, anchor, runtime.client.config.endpoint);
  if (!choices.length || choices.some((choice) => choice.selected || choice.status === 'running'))
    throw new CliError('INVALID_ARGUMENT', '请先等待当前方案生成结束，再设计一版');
  const content = initialStyleContent(raw);
  const index = Math.max(1, ...choices.map((choice) => choice.index + 1));
  // 查询失败与 Glow 一样按付费入口处理；用户已通过含费用说明的“再设计一版”授权。
  let expectFree = false;
  try {
    expectFree = (await runtime.query.designerFreeRemaining(sessionId)) > 0;
  } catch (error) {
    if (runtime.client.signal?.aborted || (error instanceof CliError && error.code === 'AUTH_REQUIRED'))
      throw error;
  }
  let response: JsonObject;
  try {
    response = await runtime.command.parallel({
      sessionId,
      preReplyMessageId: anchor,
      appendMode: true,
      items: [
        {
          index,
          mode: 6,
          framework: 6,
          content,
          businessParams: {
            business_type: 'startMV',
            appendStyleBatchCarrier: true,
            ...(expectFree ? { stage2ExpectedFree: true } : {}),
          },
        },
      ],
    });
  } catch (error) {
    throw styleRequestError(error, sessionId, anchor, choices);
  }
  if (!styleWaitTarget(response))
    throw new CliError('OUTCOME_UNKNOWN', '生成请求已返回，但缺少方案标识，请查看进度，勿重复生成', {
      sessionId,
    });
  // 服务端实际领取免费额度时不得向用户宣称本次会扣费。
  const free =
    list(response.items).length > 0 && list(response.items).every((item) => object(item).tokenFree === true);
  const notice = [
    free
      ? '高级设计师已接受委托，正在根据你的需求定制一版新方案；本次为免费委托，不扣算力值，这可能需要一些时间。'
      : APPEND_STYLE_NOTICE,
    existingStyleLinks(choices),
  ]
    .filter(Boolean)
    .join('\n\n');
  runtime.output.log(notice);
  return { ...response, stylePhase: 'append', styleNotice: notice };
}

export function styleRequestError(
  error: unknown,
  sessionId: string,
  anchor: string,
  choices: Array<Choice>,
): unknown {
  if (!(error instanceof CliError)) return error;
  const freeExpired = Number(error.details.businessCode) === 600000029;
  const instruction = freeExpired
    ? `首次免费额度已使用，本次没有创建新方案。\n\n${APPEND_STYLE_OPTION}\n${existingStyleLinks(choices)}\n也可以回复“采用 A”（使用实际已有方案编号）。等待用户选择，不自动转付费。`
    : error.code === 'OUTCOME_UNKNOWN'
      ? '暂时无法确认本次请求是否成功，请查看进度或去 superun.ai 查看详情，确认前不要重复生成。'
      : `本次方案生成未开始：${error.message}。请按实际错误处理后回复“再设计一版”，也可以采用已有方案。`;
  return new CliError(error.code, freeExpired ? '首次免费额度已使用，本次没有创建新方案' : error.message, {
    ...error.details,
    sessionId,
    preReplyMessageId: anchor,
    choices,
    instruction,
    retryable: false,
  });
}

export async function retryStyle(
  runtime: CreationRuntime,
  sessionId: string,
  choiceId: string,
): Promise<JsonObject> {
  const view = await runtime.load(sessionId);
  const anchor = view.session.pendingBranch?.preReplyMessageId;
  if (!anchor || isStyleSelected(view))
    throw new CliError('STALE_INTERACTION', '当前已离开风格选择阶段，请查看进度');
  const choices = await runtime.choices(sessionId, anchor, view);
  const choice = choices.find((item) => item.choiceId === choiceId);
  if (!choice || choice.status !== 'failed' || !choice.messageId)
    throw new CliError('INVALID_ARGUMENT', '只能重试本轮有原始任务 ID 的失败方案，请重新查询方案');
  try {
    await runtime.command.retryStyle(sessionId, choice.messageId, choice.replyMessageId);
  } catch (error) {
    throw styleRequestError(error, sessionId, anchor, choices);
  }
  const notice = `正在重新生成${styleChoiceLabel(choice)}。`;
  runtime.output.log(notice);
  return {
    sessionId,
    preReplyMessageId: anchor,
    items: [{ replyMessageId: choice.replyMessageId }],
    stylePhase: 'retry',
    styleNotice: notice,
  };
}
