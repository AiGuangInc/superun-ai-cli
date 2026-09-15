/** 与 Glow 同源的余额/额度错误识别和充值后引导。@author xiuyu.yi */
import type { NextAction } from '../contracts/cli-output.js';
import type { SessionView } from '../contracts/node-wire.js';
import { roundMessage } from './round-selector.js';
import { text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import type { GuidanceResult } from './next-actions.js';
import type { RuntimeConfig } from '../config/runtime-config.js';

const ERROR_CODES: Record<string, string> = {
  InsufficientCreditsException: '200000013',
  OwnerBalanceNotEnoughException: '600000014',
  CollaboratorBalanceNotEnoughException: '600000015',
  WorkspaceLimitNotEnoughException: '600050008',
  WorkspaceMemberMonthLimitExceededException: '600050016',
  WorkspaceMemberTotalLimitExceededException: '600050017',
};
const MESSAGES: Record<string, string> = {
  '200000013': '算力值余额不足，请前往 [superun.ai](https://superun.ai) 充值，充值完成后回复 **“重试”**。',
  '600000014':
    '项目所有者的算力值余额不足，请联系项目所有者前往 [superun.ai](https://superun.ai) 充值，充值完成后回复 **“重试”**。',
  '600000015':
    '你的算力值余额不足，请前往 [superun.ai](https://superun.ai) 充值，充值完成后回复 **“重试”**。',
  '600050008':
    '团队算力值余额不足，请前往 [superun.ai](https://superun.ai) 为对应团队充值；没有管理权限时请联系团队管理员，充值完成后回复 **“重试”**。',
  '600050016':
    '团队成员月度额度已用完，请前往 [superun.ai](https://superun.ai) 联系团队管理员调整额度，处理完成后回复 **“重试”**。',
  '600050017':
    '团队成员总额度已用完，请前往 [superun.ai](https://superun.ai) 联系团队管理员调整额度，处理完成后回复 **“重试”**。',
};

export function creditCode(value: unknown): string | undefined {
  const key = String(value ?? '');
  return Object.hasOwn(MESSAGES, key) ? key : Object.hasOwn(ERROR_CODES, key) ? ERROR_CODES[key] : undefined;
}
export function rechargeMessage(value: unknown): string | undefined {
  const code = creditCode(value);
  return code ? MESSAGES[code] : undefined;
}

/** 与 Glow 一样，仅取最后一条真实主链异常 Agent 消息；不拿假气泡或后台回执重试。 */
export function retryableMainMessage(view: SessionView): string | undefined {
  const round = view.pipeline.render?.rounds
    .filter((round) => !round.meta?.consult && !round.meta?.passive && !round.meta?.subAgentReport)
    .at(-1);
  const message = roundMessage(view, round);
  return message?.status === -1 &&
    !/^(fake-message-|pending-|user-|assistant-|insufficient-credits-)/.test(message.messageId)
    ? message.messageId
    : undefined;
}

export function rechargeAction(
  value: unknown,
  command: Array<string>,
  sessionId: string,
  messageId?: string,
  choiceId?: string,
): NextAction | undefined {
  const notice = rechargeMessage(value);
  if (!notice) return undefined;
  return {
    action: 'RECHARGE_AND_RETRY',
    requiresUserInput: true,
    instruction: `${notice} 立即展示充值链接，停止本次等待，不自动重试、不展示继续创作或上线运营。用户充值后回复“重试”才执行；重试仍不足时再次提示充值。${messageId || choiceId ? '重试原失败任务，不把原需求作为新消息发送。' : '未取得可重试的真实消息 ID，先查询当前状态，不猜测消息 ID。'}`,
    command: choiceId
      ? [...command, 'style', 'retry', '--', sessionId, choiceId]
      : messageId
        ? [...command, 'retry', '--', sessionId, messageId]
        : [...command, 'state', '--', sessionId],
  };
}

/** 批次结果没有抛异常时，在公共结果出口转换，仍走同一套欠费提示。 */
export function throwCreditResult(
  result: GuidanceResult,
  config: Pick<RuntimeConfig, 'endpoint' | 'locale'>,
): void {
  if (!result.styleGeneration || result.choices?.some((choice) => choice.selected)) return;
  const choice = result.choices?.find((choice) => choice.status === 'failed' && creditCode(choice.errorType));
  if (choice)
    throw new CliError('BUSINESS_ERROR', '方案因余额或额度不足而失败', {
      businessCode: creditCode(choice.errorType),
      sessionId: result.sessionId,
      choiceId: choice.choiceId,
      creditSource: 'execution',
      endpoint: config.endpoint,
      locale: config.locale,
    });
}

/** 同步接口拒绝没有已失败任务；由宿主保存原命令/输入，充值后重提原操作。 */
export function creditFailureDetails(details: Record<string, unknown>): Record<string, unknown> {
  const code = creditCode(details.businessCode) ?? creditCode(details.errorType);
  if (!code) return {};
  const retryMessageId = text(details.retryMessageId),
    sessionId = text(details.sessionId);
  const command = [
    'superun-ai',
    ...(text(details.endpoint) ? ['--endpoint', String(details.endpoint)] : []),
    ...(text(details.locale) ? ['--locale', String(details.locale)] : []),
    'chat',
  ];
  return {
    rechargeUrl: 'https://superun.ai',
    requiresUserInput: true,
    instruction: `${rechargeMessage(code)} 停止本次等待，不自动重试。${
      details.creditSource === 'execution'
        ? '用户确认充值后重试原失败消息，不重新创建项目或重发需求。'
        : '本次操作被余额校验拒绝；保留原命令和输入，用户确认充值后重新执行原操作，不重试之前已经完成的消息。'
    }`,
    ...(details.creditSource === 'execution' && sessionId
      ? { nextActions: [rechargeAction(code, command, sessionId, retryMessageId, text(details.choiceId))] }
      : {}),
  };
}
