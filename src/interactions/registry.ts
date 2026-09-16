/** 交互类型到纯解析器的注册表。@author xiuyu.yi */
import type { SessionView } from '../contracts/node-wire.js';
import type { InteractionParser, InteractionBinding } from './context.js';
import { currentRound, roundMessage } from '../conversation/round-selector.js';
import { hasPendingCreationWork } from '../conversation/state-resolver.js';
import { parsePrd } from './parsers/prd-clarification.js';
import { parseAskTool } from './parsers/ask-user-tool.js';
import { parseUniversalAsk } from './parsers/universal-ask-user.js';
import { parseSecret } from './parsers/secret-input.js';
import { parsePlugin } from './parsers/plugin-action.js';
import { parseDdl } from './parsers/ddl-approval.js';
import { semanticInteraction } from './parsers/semantic-action.js';
import { isStyleSelected } from './parsers/style-selection.js';
import { pendingTool, toolId, bind } from './context.js';
import { interactionId } from './interaction-id.js';
import { text } from '../contracts/value.js';

const parsers: Record<string, InteractionParser> = {
  prd_questions: parsePrd,
  ask_user_question: parseAskTool,
  universal_ask_user: parseUniversalAsk,
  tool_secrets_create: parseSecret,
  tool_plugin_secrets_create: parseSecret,
  tool_plugin: parsePlugin,
  tool_execute_ddl: parseDdl,
  managed_agent_wizard: (context) =>
    pendingTool(context.item) ? bind(context, 'MANAGED_AGENT_WIZARD', { actions: [] }) : undefined,
};

export function collectInteractions(
  view: SessionView,
  styleSelected = isStyleSelected(view),
): Array<InteractionBinding> {
  const latest = currentRound(view);
  const bindings: Array<InteractionBinding> = [];
  for (const round of view.pipeline.render?.rounds ?? []) {
    if (round.meta?.consult || round.meta?.passive) continue;
    for (const item of round.agentItems) {
      const parser = parsers[item.variant];
      if (
        pendingTool(item) &&
        (!parser ||
          (!toolId(item) && !(item.variant === 'tool_execute_ddl' && item.payload.autoApprove === true)))
      ) {
        const source = {
          roundId: round.roundId,
          messageId: item.source?.messageId ?? text(item.payload.messageId) ?? '',
          contentId: item.source?.contentId ?? text(item.payload.contentId) ?? item.id,
          variant: item.variant,
          toolId: toolId(item),
        };
        bindings.push({
          item,
          round,
          view,
          current: round.roundId === latest?.roundId,
          interaction: {
            interactionId: interactionId(round.sessionId, source),
            kind: 'UNSUPPORTED',
            source,
            supported: false,
            questions: [],
            actions: [],
            answerSchema: {},
            details: {
              variant: item.variant,
              notice: '当前 CLI 暂不支持该交互或缺少回复标识，请到 Superun 网页处理。',
            },
          },
        });
        continue;
      }
      if (!parser) continue;
      const binding = parser({
        item,
        round,
        view,
        current: round.roundId === latest?.roundId,
        message: roundMessage(view, round),
      });
      if (binding) bindings.push(binding);
    }
  }
  if (bindings.length === 0 && (!view.session.pendingBranch || styleSelected)) {
    const semantic = semanticInteraction(view, latest, roundMessage(view, latest));
    if (semantic && !(semantic.interaction.kind === 'SELECT_FEATURES' && hasPendingCreationWork(view)))
      bindings.push(semantic);
  }
  return [...new Map(bindings.map((binding) => [binding.interaction.interactionId, binding])).values()];
}
