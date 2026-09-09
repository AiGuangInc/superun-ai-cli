/** 独立读取全部后台任务，避免父消息 ETag 不变时漏掉进度。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import type { Choice, Interaction, TaskProgressItem, TaskProgressSnapshot } from '../contracts/cli-output.js';
import { parseWire, recentlySchema } from '../contracts/node-wire.js';
import type { SessionView } from '../contracts/node-wire.js';
import { text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { currentRound, roundMessage } from './round-selector.js';
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
  constructor(private readonly client: ApiClient) {}

  private cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value as Promise<T>;
    // 仅保留短期读取结果；失败不导致每一拍重复请求。
    for (const [id, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(id);
    const value = read();
    this.cache.set(key, { expires: Date.now() + REFRESH_MS, value });
    return value;
  }

  async read(
    view: SessionView,
    choices: Array<Choice>,
    interactions: Array<Interaction> = [],
  ): Promise<TaskProgressSnapshot> {
    if (this.client.signal?.aborted) throw new CliError('INTERRUPTED', '已停止本地进度查询');
    const sessionId = view.session.sessionId;
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
      const discovery = await this.cached(`tasks:${sessionId}`, async () =>
        parseWire(
          discoverySchema,
          await this.client.call('/web-api/conversation-v2/subagent-message-stream-discovery', {
            parentSessionId: sessionId,
            previewVersionId: 0,
            includeTaskTitle: true,
          }),
        ),
      );
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
    tasks.push(...children.map((entry) => entry.item), ...projectStyleTasks(choices));
    if (!currentUser && tasks.length) warnings.push('当前用户归属信息未返回，部分任务仅展示状态。');
    return taskProgressSnapshot(sessionId, tasks, warnings);
  }
}
