/** 交互内部上下文，不直接对外输出原始 payload。@author xiuyu.yi */
import type { Interaction, InteractionKind, Question } from '../contracts/cli-output.js';
import type { NodeItem, NodeRound, NodeMessage, SessionView } from '../contracts/node-wire.js';
import { object, text } from '../contracts/value.js';
import { interactionId } from './interaction-id.js';
import { CliError } from '../output/exit-codes.js';

export type ParserContext = {
  item: NodeItem;
  round: NodeRound;
  view: SessionView;
  current: boolean;
  message?: NodeMessage;
};
export type InteractionBinding = ParserContext & { interaction: Interaction };
export type InteractionParser = (context: ParserContext) => InteractionBinding | undefined;

export function toolData(item: NodeItem): Record<string, unknown> {
  return object(object(item.payload.tool).toolData);
}
export function toolId(item: NodeItem): string | undefined {
  return text(item.payload.toolId) ?? text(toolData(item).toolId);
}
export function pendingTool(item: NodeItem): boolean {
  const wrapper = 'toolStatus' in item.payload ? item.payload : object(item.payload.tool);
  return (
    wrapper.toolStatus === 0 &&
    wrapper.toolCancelled !== true &&
    !wrapper.terminalReason &&
    !item.payload.toolResult &&
    !toolData(item).toolResult
  );
}

export function bind(
  context: ParserContext,
  kind: InteractionKind,
  options: {
    actions: Array<string>;
    questions?: Array<Question>;
    schema?: Record<string, unknown>;
    details?: Record<string, unknown>;
  },
): InteractionBinding {
  const { item, round } = context;
  const messageId = item.source?.messageId ?? text(item.payload.messageId) ?? context.message?.messageId;
  const contentId = item.source?.contentId ?? text(item.payload.contentId);
  if (!messageId || !contentId)
    throw new CliError('UNSUPPORTED_INTERACTION', '交互缺少消息来源，无法构造可恢复的回复', {
      variant: item.variant,
    });
  const source = {
    roundId: round.roundId,
    messageId,
    contentId,
    variant: item.variant,
    toolId: toolId(item),
  };
  return {
    ...context,
    interaction: {
      interactionId: interactionId(round.sessionId, source),
      kind,
      source,
      questions: options.questions ?? [],
      actions: options.actions,
      answerSchema: options.schema ?? {
        type: 'object',
        properties: { action: { enum: options.actions } },
        required: ['action'],
      },
      details: options.details,
    },
  };
}
