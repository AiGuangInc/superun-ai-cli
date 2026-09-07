/** Parallel 多批次结果映射为稳定候选 ID。@author xiuyu.yi */
import { list, object, text } from '../../contracts/value.js';
import type { Choice } from '../../contracts/cli-output.js';
import { CliError } from '../../output/exit-codes.js';

export function projectChoices(response: unknown, anchor: string): Array<Choice> {
  return list(object(response).items).flatMap((batch) => {
    const info = object(object(batch).parallelInfo);
    return list(info.items).map((value) => {
      const item = object(value);
      const reply = text(item.replyMessageId);
      if (!reply || typeof item.index !== 'number')
        throw new CliError('PROTOCOL_ERROR', '风格候选缺少稳定 ID');
      return {
        choiceId: reply,
        index: item.index,
        preReplyMessageId: anchor,
        replyMessageId: reply,
        lastReplyMessageId: text(item.lastReplyMessageId),
        status:
          item.errorType || item.status === -1
            ? ('failed' as const)
            : item.status === 1
              ? ('success' as const)
              : ('running' as const),
        previewUrl: text(item.snapshotUrl),
        errorType: text(item.errorType),
        selected: info.selectedReplyMessageId === reply,
      };
    });
  });
}
