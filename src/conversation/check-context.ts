/** 审查与测试共用的轮次来源解析。@author xiuyu.yi */
import type { CheckContext } from '../contracts/cli-output.js';
import type { SessionView } from '../contracts/node-wire.js';
import { object, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { currentRound, roundContainingMessage } from './round-selector.js';
import { projectText } from './text-projector.js';

export type CheckSpec<T extends 'test' | 'review'> = {
  phase: T;
  operationKey: string;
  sourceKey: string;
  businessType: string;
};

export function checkContextFromExtra<T extends 'test' | 'review'>(
  extra: Record<string, unknown>,
  spec: CheckSpec<T>,
  sourceMessageId: string,
): CheckContext<T> | undefined {
  const phase = extra[spec.operationKey];
  if (phase === 'none') return undefined;
  if (phase !== spec.phase && phase !== 'repair' && extra.business_type !== spec.businessType)
    return undefined;
  return {
    phase: phase === 'repair' ? 'repair' : spec.phase,
    sourceMessageId,
    reportMessages: [],
    previousSourceMessageId: text(extra[spec.sourceKey]),
  };
}

/** 只读已解析的业务关联，不读取隐藏正文或模型推理。 */
export function reportReference(source: {
  roundExtra: Record<string, unknown>;
  parsedContents: Array<string>;
}): { childId: string } | { taskId: number } | undefined {
  const businessType = source.roundExtra.business_type;
  if (businessType !== 'sub_agent_report' && businessType !== 'background_task_report') return undefined;
  try {
    const references = new Set<string | number>();
    for (const value of source.parsedContents) {
      const content = object(JSON.parse(value));
      const params = object(content.bizParams);
      if (content.type !== 'user_input_item' || params.business_type !== businessType) continue;
      if (businessType === 'sub_agent_report' && text(params.fromSubAgent))
        references.add(text(params.fromSubAgent)!);
      if (
        businessType === 'background_task_report' &&
        Number.isSafeInteger(params.taskId) &&
        Number(params.taskId) > 0
      )
        references.add(Number(params.taskId));
    }
    const reference = [...references][0];
    if (references.size === 1 && reference !== undefined)
      return typeof reference === 'string' ? { childId: reference } : { taskId: reference };
  } catch {
    // 不将包含隐藏正文的解析异常透出到用户侧。
  }
  throw new CliError('PROTOCOL_ERROR', '后台回执缺少唯一的任务来源，请重新查询当前状态');
}

export function readCheckContext<T extends 'test' | 'review'>(
  view: SessionView,
  spec: CheckSpec<T>,
  anchorMessageId?: string,
): CheckContext<T> | undefined {
  const round = anchorMessageId ? roundContainingMessage(view, anchorMessageId) : currentRound(view);
  if (!round) return undefined;
  const ids = new Set([round.anchorUserMessageId, ...round.agentItems.map((item) => item.source?.messageId)]);
  const messages = view.pipeline.messages
    .filter((message) => ids.has(message.messageId))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const message of messages) {
    const extra = message.roundExtra ?? {};
    if (extra[spec.operationKey] === 'none') return undefined;
    const context = checkContextFromExtra(extra, spec, round.anchorUserMessageId);
    if (context)
      return {
        ...context,
        reportMessages: projectText([round]).messages.filter((item) => item.role === 'assistant'),
      };
  }
  return undefined;
}
