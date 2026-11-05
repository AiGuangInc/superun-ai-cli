/** 将公开执行过程转换为原消息事件可消费的内容。@author xiuyu.yi */
import { createHash } from 'node:crypto';
import type { CreationResult } from '../contracts/cli-output.js';

type ActivitySource = { messageId: string; contentId: string };
export type ExecutionGroup = {
  id: string;
  narration?: { text: string; source: ActivitySource };
  tools: Array<{
    id: string;
    source: ActivitySource;
    type: string;
    title: string;
    status?: string;
  }>;
};
export type ExecutionModule = {
  id: string;
  role: 'main' | 'subagent';
  title: string;
  sessionId: string;
  parentReplyMessageId: string;
  status: string;
  groups: ExecutionGroup[];
};
export type ExecutionActivity = {
  id: string;
  revision: string;
  complete: boolean;
  warnings: string[];
  modules: ExecutionModule[];
};

export function executionHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** 只生成过程消息；不修改业务正文、功能步骤或完成统计。 */
export function executionMessages(activity?: ExecutionActivity): CreationResult['messages'] {
  return (
    activity?.modules.flatMap((module) =>
      module.groups.map((group) => ({
        id: `execution:${executionHash([module.id, group.id])}`,
        role: 'assistant' as const,
        text: [
          `${module.role === 'main' ? '主 Agent' : `子 Agent：${module.title}`} · 执行过程`,
          group.narration?.text,
          group.tools.length ? `本组共 ${group.tools.length} 次工具调用` : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
      })),
    ) ?? []
  );
}

/** 快照也通过原消息字段交付过程，完成说明与待答问题仍放在最后。 */
export function withExecutionMessages(result: CreationResult): CreationResult {
  const execution = executionMessages(result.executionActivity);
  if (!execution.length) return result;
  const lastAssistant = result.messages.map((message) => message.role).lastIndexOf('assistant');
  const position =
    ['ACCEPTED', 'QUEUED', 'RUNNING'].includes(result.state) || lastAssistant < 0
      ? result.messages.length
      : lastAssistant;
  return {
    ...result,
    messages: [...result.messages.slice(0, position), ...execution, ...result.messages.slice(position)],
  };
}
