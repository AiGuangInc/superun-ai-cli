/** 由当前轮服务端标记推导 Stage0 与规划交互。@author xiuyu.yi */
import type { SessionView, NodeRound, NodeMessage, NodeItem } from '../../contracts/node-wire.js';
import { object, text, enabled } from '../../contracts/value.js';
import { bind } from '../context.js';
import type { InteractionBinding } from '../context.js';
import { visibleText } from '../../conversation/text-projector.js';

export function semanticInteraction(
  view: SessionView,
  round?: NodeRound,
  message?: NodeMessage,
): InteractionBinding | undefined {
  if (!round || !message) return undefined;
  const retryHandoff =
    view.extra.agentRuntime === 'shire' &&
    message.roundExtra?.business_type === 'stage0_handoff_generate' &&
    message.roundExtra?.stage0_handoff_status === 'failed' &&
    [3, -1].includes(view.session.status);
  if (!retryHandoff && (round.status !== 'completed' || view.session.status !== 3)) return undefined;
  const extra = message.roundExtra ?? {};
  let variant: string | undefined;
  let kind:
    'ENTER_IDEATION' | 'APPROVE_ARCHITECTURE_PLAN' | 'START_EXECUTION' | 'SELECT_FEATURES' | undefined;
  if (view.extra.agentRuntime === 'shire') {
    if (extra.business_type === 'stage0_handoff_generate' && extra.stage0_handoff_status !== 'failed')
      return undefined;
    variant = 'stage0_handoff';
    kind = 'ENTER_IDEATION';
  } else if (
    Number(view.extra.version) >= 6 &&
    enabled(extra.startDevelopment) &&
    !enabled(extra.architecturePlanApproved)
  ) {
    variant = 'architecture_plan_approve';
    kind = 'APPROVE_ARCHITECTURE_PLAN';
  } else if (
    round.agentItems.some((item) =>
      /<superun-action\s+type=["']start-executing["']/.test(visibleText(item.payload)),
    )
  ) {
    variant = 'start_execution';
    kind = 'START_EXECUTION';
  } else if (view.features?.some((feature) => !feature.checked && feature.id !== undefined)) {
    variant = 'select_features';
    kind = 'SELECT_FEATURES';
  }
  if (!variant || !kind) return undefined;
  const item: NodeItem = {
    id: `${round.roundId}:${variant}`,
    kind: 'card',
    variant,
    source: { messageId: message.messageId, contentId: variant },
    payload: {},
  };
  const details =
    kind === 'SELECT_FEATURES'
      ? {
          features: view.features
            ?.filter((feature) => !feature.checked && feature.id !== undefined)
            .map((feature) => ({
              id: feature.id,
              title: feature.title,
              description: feature.description,
              checked: false,
            })),
        }
      : kind === 'START_EXECUTION'
        ? { planBatchId: text(extra.plan_batch_id), mode: object(message.extra).mode }
        : retryHandoff
          ? { retry: true }
          : undefined;
  const actions = [
    kind === 'ENTER_IDEATION'
      ? 'ENTER'
      : kind === 'START_EXECUTION'
        ? 'EXECUTE'
        : kind === 'SELECT_FEATURES'
          ? 'SELECT'
          : 'APPROVE',
  ];
  return bind({ item, round, view, current: true, message }, kind, {
    actions,
    details,
    schema: {
      type: 'object',
      properties: {
        action: { enum: actions },
        featureIds: { type: 'array', items: { type: ['string', 'integer'] }, uniqueItems: true },
      },
      required: kind === 'SELECT_FEATURES' ? ['action', 'featureIds'] : ['action'],
      additionalProperties: false,
    },
  });
}
