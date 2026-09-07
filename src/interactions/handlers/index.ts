/** 按交互类型选择唯一回答路径。@author xiuyu.yi */
import type { InteractionKind } from '../../contracts/cli-output.js';
import { CliError } from '../../output/exit-codes.js';
import type { ReplyContext, ReplyHandler } from './types.js';
import { replyPrd } from './reply-prd.js';
import { replyAsk } from './reply-ask.js';
import { replyUniversalAsk } from './reply-universal-ask.js';
import { replySecret } from './reply-secret.js';
import { replyPlugin } from './reply-plugin.js';
import { replyDdl } from './reply-ddl.js';
import { replyStyle } from './reply-style.js';
import { replySemantic } from './reply-semantic.js';

const handlers: Record<InteractionKind, ReplyHandler> = {
  PRD_CLARIFICATION: replyPrd,
  ASK_USER_TOOL: replyAsk,
  ASK_USER_MESSAGE: replyUniversalAsk,
  SECRET_INPUT: replySecret,
  PLUGIN_SECRET_INPUT: replySecret,
  PLUGIN_ACTION: replyPlugin,
  DDL_CONFIRMATION: replyDdl,
  STYLE_SELECTION: replyStyle,
  ENTER_IDEATION: replySemantic,
  APPROVE_ARCHITECTURE_PLAN: replySemantic,
  SELECT_FEATURES: replySemantic,
  START_EXECUTION: replySemantic,
};
export async function dispatchReply(context: ReplyContext): Promise<Record<string, unknown>> {
  const fields: Record<InteractionKind, Array<string>> = {
    PRD_CLARIFICATION: ['action', 'answers', 'styleCount'],
    ASK_USER_TOOL: ['action', 'answers'],
    ASK_USER_MESSAGE: ['action', 'answers'],
    SECRET_INPUT: ['action', 'values'],
    PLUGIN_SECRET_INPUT: ['action', 'values'],
    PLUGIN_ACTION: ['action', 'config'],
    DDL_CONFIRMATION: ['action'],
    STYLE_SELECTION: ['action', 'choiceId'],
    ENTER_IDEATION: ['action'],
    APPROVE_ARCHITECTURE_PLAN: ['action'],
    SELECT_FEATURES: ['action', 'featureIds'],
    START_EXECUTION: ['action', 'featureIds'],
  };
  if (Object.keys(context.input).some((key) => !fields[context.binding.interaction.kind].includes(key)))
    throw new CliError('INVALID_ARGUMENT', '回答包含当前交互不支持的字段');
  const action =
    context.input.action ?? (context.binding.interaction.actions.includes('SUBMIT') ? 'SUBMIT' : undefined);
  if (typeof action !== 'string' || !context.binding.interaction.actions.includes(action))
    throw new CliError('INVALID_ARGUMENT', 'action 不在当前交互允许的动作中');
  return handlers[context.binding.interaction.kind]({ ...context, input: { ...context.input, action } });
}
