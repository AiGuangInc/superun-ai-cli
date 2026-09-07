/** 将会话正文和任务进度转换为命令结果。@author xiuyu.yi */
import type { NodeRound } from '../contracts/node-wire.js';
import { list, object, text } from '../contracts/value.js';
import type { CreationResult } from '../contracts/cli-output.js';

export function visibleText(payload: Record<string, unknown>): string {
  const parts = [
    text(payload.text),
    ...list(payload.blocks).map((block) => {
      const value = object(block);
      return value.type === 'text' ? text(value.text) : undefined;
    }),
  ].filter((value): value is string => !!value?.trim());
  return [...new Set(parts)].join('\n');
}

export function projectText(rounds: Array<NodeRound>): Pick<CreationResult, 'messages' | 'progress'> {
  const messages: CreationResult['messages'] = [];
  const progress: CreationResult['progress'] = [];
  for (const round of rounds) {
    for (const item of [...round.userItems, ...round.agentItems]) {
      if (item.kind === 'bubble') {
        const content = visibleText(item.payload)
          .replace(/<superun-action\s+type=["']start-executing["']\s*\/?>/g, '')
          .trim();
        if (content)
          messages.push({ id: item.id, role: item.role === 'user' ? 'user' : 'assistant', text: content });
      }
      if (item.kind === 'activity-entry') {
        const summary = object(item.payload.summary);
        const content = text(summary.title) ?? text(summary.text) ?? visibleText(item.payload);
        if (content) progress.push({ id: item.id, text: content, status: text(summary.status) });
      }
      if (item.variant === 'work_block')
        progress.push({
          id: item.id,
          text: text(item.payload.taskTitle) ?? '后台任务',
          status: text(item.payload.status),
        });
    }
  }
  return { messages, progress };
}
