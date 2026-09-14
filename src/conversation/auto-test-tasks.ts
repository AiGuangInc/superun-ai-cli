/** 读取独立 E2E 后台任务的启动与回投事实。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import type { SessionView } from '../contracts/node-wire.js';
import { parseWire } from '../contracts/node-wire.js';
import { object, text } from '../contracts/value.js';
import { currentRound } from './round-selector.js';
import type { TaskProgressItem } from '../contracts/cli-output.js';

const snapshotSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  status: z.number(),
  roundExtra: z.record(z.unknown()).default({}),
  parsedContents: z.array(z.string()),
});
const associationsSchema = z.array(
  z.object({ taskId: z.number().int().positive().safe(), parentReplyMessageId: z.string() }),
);
type Snapshot = z.infer<typeof snapshotSchema>;

export class AutoTestTasks {
  private readonly snapshots = new Map<string, { expires: number; value: Snapshot }>();
  constructor(private readonly client: ApiClient) {}

  private async snapshot(sessionId: string, messageId: string): Promise<Snapshot> {
    const key = `${sessionId}:${messageId}`;
    const cached = this.snapshots.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = parseWire(
      snapshotSchema,
      await this.client.call('/api/uxa-center/agent/AgentQuery/fetchMessageSnapshot', {
        sessionId,
        messageId,
        previewVersionId: 0,
        preferParsedContent: true,
        preferHumanizedContent: true,
        slimUserInputContent: true,
      }),
    );
    if (value.sessionId !== sessionId || value.messageId !== messageId)
      throw new Error('测试任务快照来源不一致');
    this.snapshots.set(key, {
      value,
      expires: Date.now() + ([1, -1].includes(value.status) ? 300_000 : 2_000),
    });
    return value;
  }

  private contents(snapshot: Snapshot): Array<Record<string, unknown>> {
    // 只消费服务端已解析工具字段，不读取 raw_message 或模型推理。
    return snapshot.parsedContents.map((value) => parseWire(z.record(z.unknown()), JSON.parse(value)));
  }

  async reportTaskId(view: SessionView, messageId: string): Promise<number | undefined> {
    const message = view.pipeline.messages.find((item) => item.messageId === messageId);
    if (message?.roundExtra?.business_type !== 'background_task_report') return undefined;
    const snapshot = await this.snapshot(view.session.sessionId, messageId);
    const ids = new Set(
      this.contents(snapshot).flatMap((item) => {
        const params = object(item.bizParams);
        return params.business_type === 'background_task_report' &&
          Number.isSafeInteger(params.taskId) &&
          Number(params.taskId) > 0
          ? [Number(params.taskId)]
          : [];
      }),
    );
    return ids.size === 1 ? [...ids][0] : undefined;
  }

  async reportParent(view: SessionView, anchorMessageId?: string): Promise<string | undefined> {
    const round = anchorMessageId
      ? view.pipeline.render?.rounds.find((item) => item.anchorUserMessageId === anchorMessageId)
      : currentRound(view);
    if (!round) return undefined;
    const taskId = await this.reportTaskId(view, round.anchorUserMessageId);
    if (!taskId) return undefined;
    return this.parentForTask(view.session.sessionId, taskId);
  }

  async parentForTask(sessionId: string, taskId: number): Promise<string | undefined> {
    const rows = parseWire(
      associationsSchema,
      await this.client.call('/api/uxa-center/agent/AgentQuery/batchQueryBackgroundTaskAssociations', {
        parentSessionId: sessionId,
        taskIds: [taskId],
      }),
    );
    const parents = new Set(
      rows.filter((row) => row.taskId === taskId).map((row) => row.parentReplyMessageId),
    );
    return parents.size === 1 ? [...parents][0] : undefined;
  }

  async pending(view: SessionView): Promise<Array<TaskProgressItem>> {
    const round = currentRound(view);
    if (!round) return [];
    const sources = new Set(round.agentItems.map((item) => item.source?.messageId));
    const messages = view.pipeline.messages.filter(
      (message) =>
        message.role === 2 &&
        (message.replyMessageId === round.anchorUserMessageId || sources.has(message.messageId)),
    );
    const launches = new Map<number, string>();
    for (const message of messages) {
      for (const content of this.contents(await this.snapshot(view.session.sessionId, message.messageId))) {
        const tool = object(content.tool),
          data = object(tool.toolData),
          params = object(data.toolParams);
        if (
          data.toolName !== 'TaskAgentTool' ||
          params.subagent_type !== 'e2e-tester' ||
          params.background !== true ||
          tool.toolCancelled
        )
          continue;
        const match = /^Background task started: bg:([1-9]\d*)\b/.exec(text(data.toolResult) ?? '');
        const id = Number(match?.[1]);
        if (Number.isSafeInteger(id) && id > 0) launches.set(id, text(params.description) ?? '自动测试');
      }
    }
    if (!launches.size) return [];
    for (const user of view.pipeline.messages.filter(
      (message) => message.role === 1 && message.roundExtra?.business_type === 'background_task_report',
    )) {
      const id = await this.reportTaskId(view, user.messageId);
      if (!id || !launches.has(id)) continue;
      const replies = view.pipeline.messages.filter(
        (message) => message.role === 2 && message.replyMessageId === user.messageId,
      );
      if (replies.length && replies.every((reply) => [1, -1].includes(reply.status ?? 0)))
        launches.delete(id);
    }
    return [...launches].map(([id, title]) => ({
      id: `auto-test:${id}`,
      kind: 'subtask',
      title,
      status: 'waiting',
      detail: '测试已启动，等待测试结果回传及后续处理完成。',
    }));
  }
}
