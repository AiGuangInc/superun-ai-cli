/** 根据服务端来源生成交互标识，回复时重查。@author xiuyu.yi */
import { createHash } from 'node:crypto';
import type { Interaction } from '../contracts/cli-output.js';
export function interactionId(sessionId: string, source: Interaction['source']): string {
  return `int_${createHash('sha256')
    .update(
      [
        sessionId,
        source.roundId,
        source.messageId,
        source.contentId,
        source.variant,
        source.toolId ?? '',
      ].join('|'),
    )
    .digest('hex')}`;
}
