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
import { pendingTool, toolId } from './context.js';
import { CliError } from '../output/exit-codes.js';

const parsers: Record<string, InteractionParser> = {
  prd_questions: parsePrd,
  ask_user_question: parseAskTool,
  universal_ask_user: parseUniversalAsk,
  tool_secrets_create: parseSecret,
  tool_plugin_secrets_create: parseSecret,
  tool_plugin: parsePlugin,
  tool_execute_ddl: parseDdl,
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
      if (
        pendingTool(item) &&
        !toolId(item) &&
        !(item.variant === 'tool_execute_ddl' && item.payload.autoApprove === true)
      ) {
        throw new CliError('UNSUPPORTED_INTERACTION', '等待中的工具缺少可回复标识', {
          variant: item.variant,
          sessionId: view.session.sessionId,
        });
      }
      const parser = parsers[item.variant];
      if (!parser) {
        if (pendingTool(item))
          throw new CliError('UNSUPPORTED_INTERACTION', '当前 CLI 尚未支持该阻断交互', {
            variant: item.variant,
            sessionId: view.session.sessionId,
          });
        continue;
      }
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
