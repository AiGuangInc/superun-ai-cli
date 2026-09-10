/** 自动回复规则注册表。@author xiuyu.yi */
import type { SessionView } from '../contracts/node-wire.js';
import { object, text, enabled } from '../contracts/value.js';

export function pendingAutomaticTools(
  view: SessionView,
): Array<{ key: string; toolId: string; name: string }> {
  const found: Array<{ key: string; toolId: string; name: string }> = [];
  for (const message of view.pipeline.messages)
    for (const content of message.displayContents) {
      const tool = object(content.tool),
        data = object(tool.toolData);
      if (tool.toolStatus !== 0 || tool.toolCancelled || tool.terminalReason) continue;
      const name = text(data.toolName),
        toolId = text(data.toolId);
      if (name === 'ReadLogs' && toolId) found.push({ key: `${message.messageId}:${toolId}`, toolId, name });
    }
  return [...new Map(found.map((item) => [item.key, item])).values()];
}

export function hasServerAutomaticWork(view: SessionView): boolean {
  return (
    (view.pipeline.render?.rounds ?? []).some((round) =>
      round.agentItems.some(
        (item) =>
          (view.activeSubagentWork === undefined &&
            item.variant === 'work_block' &&
            ['running', 'unknown'].includes(String(item.payload.status))) ||
          (item.variant === 'tool_execute_ddl' &&
            item.payload.toolStatus === 0 &&
            item.payload.autoApprove === true),
      ),
    ) ||
    view.pipeline.messages.some((message) =>
      message.displayContents.some((content) => {
        const tool = object(content.tool),
          data = object(tool.toolData);
        return (
          tool.toolStatus === 0 &&
          !tool.toolCancelled &&
          !tool.terminalReason &&
          (data.toolName === 'AskMainAgent' || enabled(object(content.extra).AUTO_APPROVE))
        );
      }),
    )
  );
}
