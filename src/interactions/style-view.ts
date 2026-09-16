/** 就绪风格候选的通用选择视图，沿用已有 selectStyle 业务路径。@author xiuyu.yi */
import type { Choice, Interaction } from '../contracts/cli-output.js';
import { fingerprint } from './draft-store.js';
import { interactionView } from './view-adapter.js';
import { readyStyleChoices } from './parsers/style-selection.js';
export function styleInteraction(
  sessionId: string,
  messageId: string | undefined,
  anchor: string,
  choices: Choice[],
): Interaction | undefined {
  if (!readyStyleChoices(choices).length) return undefined;
  const interaction: Interaction = {
    interactionId: `style_${fingerprint([sessionId, anchor])}`,
    kind: 'STYLE_SELECTION',
    source: {
      roundId: anchor,
      messageId: messageId ?? anchor,
      contentId: 'style-selection',
      variant: 'style-selection',
    },
    questions: [],
    actions: ['SELECT'],
    answerSchema: {
      type: 'object',
      required: ['action', 'choiceId'],
      properties: { action: { const: 'SELECT' }, choiceId: { type: 'string' } },
    },
  };
  return { ...interaction, view: interactionView(interaction, { choices }).view };
}
