/** 独立读取全部后台任务，避免父消息 ETag 不变时漏掉进度。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import type {
  Choice,
  CreationResult,
  Interaction,
  TaskProgressItem,
  TaskProgressSnapshot,
} from '../contracts/cli-output.js';
import { parseWire, recentlySchema } from '../contracts/node-wire.js';
import type { SessionView } from '../contracts/node-wire.js';
import { enabled, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { currentRound, roundMessage } from './round-selector.js';
import { projectFeatureTasks } from './feature-progress.js';
import {
  activeTask,
  messageTaskStatus,
  ownerId,
  projectMessageTasks,
  projectStyleTasks,
  roundOwner,
  roundProgressDetail,
  taskProgressSnapshot,
  workBlockStatus,
} from './task-progress.js';

const taskSchema = z.object({
  taskKey: z.string(),
  agentId: z.string().nullish(),
  childSessionId: z.string().nullish(),
  parentReplyMessageId: z.string().nullish(),
  taskTitle: z.string().nullish(),
  ownerUserId: z.union([z.string(), z.number()]).nullish(),
  status: z.number().nullish(),
  associationStatus: z.number().nullish(),
});
const discoverySchema = z.object({
  tasks: z.array(taskSchema),
  truncated: z.boolean(),
  causalAssociations: z
    .array(z.object({ childSessionId: z.string().nullish(), associationStatus: z.number().nullish() }))
    .optional(),
});
type TaskMetadata = z.infer<typeof taskSchema>;
const REFRESH_MS = 2_000;

export class TaskProgressReader {
  private readonly cache = new Map<string, { expires: number; value: Promise<unknown> }>();
  private readonly toolUsage = new Map<
    string,
    { messageId?: string; summary: NonNullable<CreationResult['toolUsage']> }
  >();
  constructor(private readonly client: ApiClient) {}

  completionSummary(sessionId: string, messageId?: string): CreationResult['toolUsage'] {
    const usage = this.toolUsage.get(sessionId);
    return messageId && usage?.messageId === messageId ? usage.summary : undefined;
  }

  private cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value as Promise<T>;
    // 仅保留短期读取结果；失败不导致每一拍重复请求。
    for (const [id, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(id);
    const value = read();
    this.cache.set(key, { expires: Date.now() + REFRESH_MS, value });
    return value;
  }

  private discovery(sessionId: string): Promise<z.infer<typeof discoverySchema>> {
    return this.cached(`tasks:${sessionId}`, async () =>
      parseWire(
        discoverySchema,
        await this.client.call('/web-api/conversation-v2/subagent-message-stream-discovery', {
          parentSessionId: sessionId,
          previewVersionId: 0,
          includeTaskTitle: true,
        }),
      ),
    );
  }

  async hasPendingSubagentWork(sessionId: string): Promise<boolean> {
    try {
      const discovery = await this.discovery(sessionId);
      if (discovery.truncated) return true;
      const removed = new Set(
        (discovery.causalAssociations ?? [])
          .filter((association) => association.associationStatus === 1)
          .map((association) => association.childSessionId)
          .filter((id): id is string => !!id),
      );
      // 对齐 Glow 的权威 task 表：只有消息 END / EXCEPTION_END 是子任务终态。
      return discovery.tasks.some(
        (task) =>
          task.associationStatus !== 1 &&
          !removed.has(task.childSessionId || task.agentId || task.taskKey) &&
          ![1, -1].includes(task.status ?? 0),
      );
    } catch {
      if (this.client.signal?.aborted) throw new CliError('INTERRUPTED', '已停止本地进度查询');
      // 不把读取失败当成没有子任务；read 会复用本次失败并输出进度警告。
      return true;
    }
  }

  async read(
    view: SessionView,
    choices: Array<Choice>,
    interactions: Array<Interaction> = [],
  ): Promise<TaskProgressSnapshot> {
    if (this.client.signal?.aborted) throw new CliError('INTERRUPTED', '已停止本地进度查询');
    const sessionId = view.session.sessionId;
    this.toolUsage.delete(sessionId);
    const current = currentRound(view);
    const currentUser = ownerId(view.pipeline.render?.currentUserId);
    const warnings: Array<string> = [];
    const tasks = projectMessageTasks(view, interactions);
    const childTasks = new Map<
      string,
      { item: TaskProgressItem; owner?: string; parent?: string; child?: string }
    >();
    for (const round of view.pipeline.render?.rounds ?? []) {
      for (const block of round.agentItems) {
        if (block.variant !== 'work_block') continue;
        const agentId = text(block.payload.agentId);
        if (!agentId) continue;
        const status = workBlockStatus(block.payload.status);
        if (!activeTask(status) && status !== 'unknown' && round.roundId !== current?.roundId) continue;
        const owner = roundOwner(view, round);
        const own = currentUser !== undefined && owner === currentUser;
        childTasks.set(agentId, {
          owner,
          parent: round.anchorUserMessageId,
          child: agentId,
          item: {
            id: `subtask:${agentId}`,
            kind: own ? 'subtask' : 'other-member',
            title: own ? text(block.payload.taskTitle) || '后台任务' : '其他成员或归属待确认的后台任务',
            status,
            agentId,
            roundId: round.roundId,
          },
        });
      }
    }
    try {
      const discovery = await this.discovery(sessionId);
      if (discovery.truncated) warnings.push('后台任务列表尚未完整返回，已展示当前可确认的任务。');
      const seen = new Map<string, TaskMetadata>();
      const removed = new Set<string>();
      for (const association of discovery.causalAssociations ?? [])
        if (association.associationStatus === 1 && association.childSessionId)
          removed.add(association.childSessionId);
      for (const task of discovery.tasks) {
        const id = task.agentId || task.childSessionId || task.taskKey;
        if (task.associationStatus === 1) {
          removed.add(id);
          continue;
        }
        const previous = seen.get(id);
        const conflict =
          previous &&
          (ownerId(previous.ownerUserId) !== ownerId(task.ownerUserId) ||
            previous.parentReplyMessageId !== task.parentReplyMessageId);
        seen.set(id, conflict ? { ...task, ownerUserId: null } : task);
        if (conflict) warnings.push('部分任务归属不明确，仅展示其状态。');
        const status = messageTaskStatus(task.status);
        const sameRound = task.parentReplyMessageId === current?.anchorUserMessageId;
        if (!activeTask(status) && status !== 'unknown' && !sameRound) {
          childTasks.delete(id);
          continue;
        }
        const owner = conflict ? undefined : ownerId(task.ownerUserId);
        const own = currentUser !== undefined && owner === currentUser;
        childTasks.set(id, {
          owner,
          parent: task.parentReplyMessageId ?? undefined,
          child: task.childSessionId || task.agentId || undefined,
          item: {
            id: `subtask:${id}`,
            kind: own ? 'subtask' : 'other-member',
            title: own ? task.taskTitle?.trim() || '后台任务' : '其他成员或归属待确认的后台任务',
            status,
            agentId: task.agentId ?? undefined,
          },
        });
      }
      for (const [id, entry] of childTasks)
        if (removed.has(id) || (entry.child && removed.has(entry.child))) childTasks.delete(id);
    } catch {
      if (this.client.signal?.aborted) throw new CliError('INTERRUPTED', '已停止本地进度查询');
      warnings.push('后台任务独立进度暂不可用，当前使用消息中已有的任务状态。');
    }
    // 所有活跃子任务都读取，但限制同时发出的请求数量，避免并发任务多时压满接口。
    const children = [...childTasks.values()];
    let offset = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, children.length) }, async () => {
        while (offset < children.length) {
          const entry = children[offset++]!;
          if (
            !entry.child ||
            entry.owner !== currentUser ||
            !currentUser ||
            (!activeTask(entry.item.status) && entry.item.status !== 'unknown')
          )
            continue;
          try {
            const child = await this.cached(`child:${entry.child}`, async () =>
              parseWire(
                recentlySchema,
                await this.client.call('/web-api/conversation-v2/subagent-recently', {
                  sessionId: entry.child,
                  previewVersionId: 0,
                  withAttachment: false,
                  withAllAttachmentContent: false,
                }),
              ),
            );
            const childView: SessionView = { ...child, extra: {} };
            const round = currentRound(childView);
            if (!round) continue;
            const message = roundMessage(childView, round);
            let status = messageTaskStatus(message?.status);
            if (child.session.status === -1 || round.status === 'failed') status = 'failed';
            else if (child.session.status === 3 && round.status === 'completed') status = 'completed';
            else if (child.session.status === 2) status = 'interrupted';
            else if (status === 'completed') status = 'waiting';
            entry.item = {
              ...entry.item,
              status,
              messageId: message?.messageId,
              ...roundProgressDetail(childView, round),
            };
          } catch {
            if (this.client.signal?.aborted) throw new CliError('INTERRUPTED', '已停止本地进度查询');
            warnings.push('部分后台任务的详细进度暂不可用，其任务状态仍按列表展示。');
          }
        }
      }),
    );
    // 与 Glow 完成气泡同源，只取当前轮 activity.summary.toolCount。
    // 子任务有自己的工具摘要，不能累加到主任务气泡上。
    if (current && currentUser && roundOwner(view, current) === currentUser) {
      const toolCount = roundProgressDetail(view, current).activity?.toolCount;
      const complete = toolCount !== undefined;
      this.toolUsage.set(sessionId, {
        messageId: roundMessage(view, current)?.messageId,
        summary: {
          ...(toolCount !== undefined ? { toolCount } : {}),
          complete,
          markdown: complete
            ? `已生成：${toolCount} 次工具调用`
            : '本轮工具调用次数暂不可用（统计数据未完整返回）。',
        },
      });
    }
    tasks.push(...children.map((entry) => entry.item), ...projectStyleTasks(choices));
    if (!currentUser && tasks.length) warnings.push('当前用户归属信息未返回，部分任务仅展示状态。');
    const extra = roundMessage(view, current)?.roundExtra ?? {};
    // 仅在当前用户的已确认研发阶段读取内部进度；咨询、风格和归属未知时保留原展示。
    if (
      current &&
      currentUser &&
      roundOwner(view, current) === currentUser &&
      enabled(extra.startDevelopment) &&
      enabled(extra.architecturePlanApproved)
    ) {
      try {
        const features = await this.cached(`features:${sessionId}`, async () => {
          const [featureData, todoData] = await Promise.all(
            ['internal/features.json', 'internal/todos.json'].map((name) =>
              this.client.call('/api/uxa-center/agent/AgentQuery/queryAttachment', { sessionId, name }),
            ),
          );
          return projectFeatureTasks(sessionId, featureData, todoData);
        });
        // 查询成功但没有开发中功能时，不回填上一轮的已完成任务。
        return taskProgressSnapshot(sessionId, features, warnings);
      } catch {
        if (this.client.signal?.aborted) throw new CliError('INTERRUPTED', '已停止本地进度查询');
        warnings.push('功能步骤暂不可用，当前显示执行状态，不能据此判断步骤完成情况。');
      }
    }
    return taskProgressSnapshot(sessionId, tasks, warnings);
  }
}
