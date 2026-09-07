/** 自动响应无需用户输入的日志读取请求。@author xiuyu.yi */
import type { AgentCommandApi } from '../api/agent-command-api.js';
export async function replyReadLogs(api: AgentCommandApi, sessionId: string, toolId: string): Promise<void> {
  await api.reply(sessionId, toolId);
}
