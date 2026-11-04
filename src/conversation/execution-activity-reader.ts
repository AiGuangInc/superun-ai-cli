/** 在原观察周期中读取主任务和父绑定子任务的公开执行过程。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import type { NodeRound, SessionView } from '../contracts/node-wire.js';
import { list, object, text } from '../contracts/value.js';
import { currentRound, roundContainingMessage } from './round-selector.js';
import { ownerId, roundOwner } from './task-progress.js';
import type { TaskProgressReader } from './task-progress-reader.js';
import { CliError } from '../output/exit-codes.js';
import { executionHash } from './execution-activity.js';
import type { ExecutionActivity, ExecutionGroup, ExecutionModule } from './execution-activity.js';

const source = z.object({ messageId: z.string().min(1), contentId: z.string().min(1) });
const timeline = z.object({
  version: z.literal(2),
  groups: z.array(
    z.object({
      id: z.string().min(1),
      narration: z.object({ text: z.string(), source }).optional(),
      tools: z.array(
        z.object({
          id: z.string().min(1),
          source,
          item: z.object({
            kind: z.literal('tool'),
            toolKind: z.string(),
            title: z.string(),
            status: z.string().optional(),
          }),
        }),
      ),
    }),
  ),
});

export type ExecutionScope = {
  rounds?: NodeRound[];
  runId?: string;
  consultId?: string;
  anchorUserMessageId?: string;
};

/** 同一 child 的归属须全部一致，不能只选其中一条可匹配记录。 */
function conflictingChildren(tasks: readonly unknown[]): Set<string> {
  const owners = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const value of tasks) {
    const task = object(value);
    const child = text(task.childSessionId);
    if (!child) continue;
    const identity = JSON.stringify([ownerId(task.ownerUserId), task.parentReplyMessageId ?? null]);
    const previous = owners.get(child);
    if (previous !== undefined && previous !== identity) conflicts.add(child);
    owners.set(child, identity);
  }
  return conflicts;
}

/** 以本拍服务端顺序更新已知分组，并在原锚点旁保留未回传的历史分组。 */
function mergeGroups(previous: ExecutionGroup[], current: ExecutionGroup[]): ExecutionGroup[] {
  const fresh = [...new Map(current.map((group) => [group.id, group])).values()];
  const positions = new Map(fresh.map((group, index) => [group.id, index]));
  const groups: ExecutionGroup[] = [];
  let next = 0;
  for (const group of previous) {
    const position = positions.get(group.id);
    if (position === undefined) groups.push(group);
    else while (next <= position) groups.push(fresh[next++]!);
  }
  return [...groups, ...fresh.slice(next)];
}

export class ExecutionActivityReader {
  private previous?: ExecutionActivity;
  constructor(
    private readonly client: ApiClient,
    private readonly progress: TaskProgressReader,
  ) {}

  async read(view: SessionView, scope: ExecutionScope = {}): Promise<ExecutionActivity> {
    const selected = scope.rounds ?? [currentRound(view)].filter((round): round is NodeRound => !!round);
    const warnings: string[] = [];
    // 最终后台回执可能独立成轮，只为过程展示沿真实 child → parent 关系回到原任务。
    if (!scope.rounds) {
      let round = selected[0];
      const seen = new Set(selected.map((item) => item.roundId));
      try {
        while (round?.meta?.subAgentReport) {
          const child = text(round.meta.subAgentReportFrom);
          const parent = child
            ? await this.progress.parentReplyMessageId(view.session.sessionId, child)
            : undefined;
          const origin = parent ? roundContainingMessage(view, parent) : undefined;
          if (!origin || seen.has(origin.roundId)) {
            warnings.push('部分回执的原任务关联尚未同步，未猜测历史过程。');
            break;
          }
          selected.unshift(origin);
          seen.add(origin.roundId);
          round = origin;
        }
      } catch {
        if (this.client.signal?.aborted) throw new CliError('INTERRUPTED', '已停止本地执行过程查询');
        warnings.push('原任务执行过程关联暂不可用。');
      }
    }
    const user = ownerId(view.pipeline.render?.currentUserId);
    const rounds = selected.filter((round) => user && roundOwner(view, round) === user);
    const id = `execution:${executionHash([
      view.session.sessionId,
      scope.runId ?? scope.consultId ?? scope.anchorUserMessageId ?? selected[0]?.anchorUserMessageId,
    ])}`;
    if (selected.length && rounds.length !== selected.length)
      warnings.push('部分执行过程归属无法确认，未展示其内容。');
    const modules = new Map<string, ExecutionModule>();
    const append = (
      role: ExecutionModule['role'],
      sessionId: string,
      parent: string,
      title: string,
      activity: unknown,
      status: string,
    ) => {
      const raw = object(activity).timeline;
      if (raw === undefined) return;
      const parsed = timeline.safeParse(raw);
      if (!parsed.success) {
        warnings.push('部分执行过程格式不完整，未展示不可靠记录。');
        return;
      }
      const groups: ExecutionGroup[] = parsed.data.groups
        .map((group) => ({
          id: group.id,
          ...(group.narration?.text.trim() ? { narration: group.narration } : {}),
          tools: group.tools.map((tool) => ({
            id: tool.id,
            source: tool.source,
            type: tool.item.toolKind,
            title: tool.item.title,
            ...(tool.item.status ? { status: tool.item.status } : {}),
          })),
        }))
        .filter((group) => group.narration || group.tools.length);
      if (!groups.length) return;
      const moduleId = executionHash([view.session.sessionId, parent, role, sessionId]);
      modules.set(moduleId, {
        id: moduleId,
        role,
        title,
        sessionId,
        parentReplyMessageId: parent,
        status,
        groups: mergeGroups(modules.get(moduleId)?.groups ?? [], groups),
      });
    };
    for (const round of rounds)
      append(
        'main',
        view.session.sessionId,
        round.anchorUserMessageId,
        '主 Agent',
        round.activity,
        round.status,
      );

    const allowedChildren = new Set<string>();
    const rejectedChildren = new Set<string>();
    const rejectConflicts = (tasks: readonly unknown[]) => {
      const conflicts = conflictingChildren(tasks);
      for (const child of conflicts) rejectedChildren.add(child);
      if (conflicts.size) warnings.push('部分子任务归属冲突，未展示其执行过程。');
    };
    if (rounds.length) {
      try {
        const discovery = await this.progress.subagentTasks(view.session.sessionId);
        if (discovery.truncated || discovery.causalStale || discovery.causalTruncated)
          throw new Error('子任务关联尚未完整同步');
        const parents = new Set(
          rounds.flatMap((round) => [
            round.anchorUserMessageId,
            ...list(round.meta?.sourceMessageIds).filter(
              (value): value is string => typeof value === 'string',
            ),
          ]),
        );
        const removed = new Set(
          (discovery.causalAssociations ?? [])
            .filter((task) => task.associationStatus === 1)
            .map((task) => task.childSessionId),
        );
        for (const task of discovery.tasks)
          if (task.associationStatus === 1 && task.childSessionId) removed.add(task.childSessionId);
        for (const child of removed) if (child) rejectedChildren.add(child);
        rejectConflicts(discovery.tasks);
        const tasks = discovery.tasks.filter(
          (task) =>
            task.childSessionId &&
            parents.has(task.parentReplyMessageId ?? '') &&
            ownerId(task.ownerUserId) === user &&
            task.associationStatus !== 1 &&
            !rejectedChildren.has(task.childSessionId),
        );
        for (const task of tasks)
          allowedChildren.add(executionHash([task.childSessionId, task.parentReplyMessageId]));
        if (tasks.length) {
          const response = object(
            await this.client.call('/web-api/conversation-v2/subagent-message-stream', {
              parentSessionId: view.session.sessionId,
              previewVersionId: 0,
              toolActivityVersion: 2,
              includeTaskTitle: true,
            }),
          );
          if (
            response.stale !== false ||
            response.truncated !== false ||
            response.causalStale ||
            response.causalTruncated ||
            !Array.isArray(response.entries) ||
            !Array.isArray(response.tasks)
          )
            throw new Error('子任务过程尚未完整同步');
          rejectConflicts(response.tasks);
          for (const value of response.tasks) {
            const task = object(value);
            const child = text(task.childSessionId);
            if (child && task.associationStatus === 1) rejectedChildren.add(child);
          }
          // full stream 的最新归属必须仍与发现结果一致，不能复活已移除或异主的记录。
          for (const task of tasks)
            if (
              rejectedChildren.has(task.childSessionId!) ||
              !response.tasks.some((item) => {
                const current = object(item);
                return (
                  current.childSessionId === task.childSessionId &&
                  current.parentReplyMessageId === task.parentReplyMessageId &&
                  ownerId(current.ownerUserId) === user &&
                  current.associationStatus !== 1
                );
              })
            )
              allowedChildren.delete(executionHash([task.childSessionId, task.parentReplyMessageId]));
          for (const value of list(response.entries)) {
            const entry = object(value);
            const task = tasks.find(
              (candidate) =>
                candidate.childSessionId === entry.childSessionId &&
                candidate.parentReplyMessageId === entry.parentReplyMessageId &&
                allowedChildren.has(
                  executionHash([candidate.childSessionId, candidate.parentReplyMessageId]),
                ),
            );
            if (entry.kind !== 'child_agent_group' || !task?.childSessionId || !task.parentReplyMessageId)
              continue;
            const activity = object(object(entry.activityCarrier).activity);
            append(
              'subagent',
              task.childSessionId,
              task.parentReplyMessageId,
              task.taskTitle?.trim() || '后台任务',
              activity,
              text(activity.status) ?? 'unknown',
            );
          }
        }
      } catch {
        if (this.client.signal?.aborted) throw new CliError('INTERRUPTED', '已停止本地执行过程查询');
        warnings.push('子任务执行过程暂不可用，未改变原任务状态。');
        // 关联读取失败时保留同一作用域已确认的记录，不把缺失当作删除。
        if (this.previous?.id === id)
          for (const module of this.previous.modules)
            if (module.role === 'subagent' && !rejectedChildren.has(module.sessionId))
              allowedChildren.add(executionHash([module.sessionId, module.parentReplyMessageId]));
      }
    }
    const merged = new Map<string, ExecutionModule>();
    for (const module of this.previous?.id === id ? this.previous.modules : [])
      if (
        rounds.length &&
        (module.role === 'main' ||
          allowedChildren.has(executionHash([module.sessionId, module.parentReplyMessageId])))
      )
        merged.set(module.id, module);
    for (const module of modules.values()) {
      const groups = mergeGroups(merged.get(module.id)?.groups ?? [], module.groups);
      merged.set(module.id, { ...module, groups });
    }
    // 片段聚合后按真实工具来源去重，不能因重复 carrier 增加次数。
    const unique = [...merged.values()].map((module) => {
      const seen = new Set<string>();
      return {
        ...module,
        groups: module.groups
          .map((group) => ({
            ...group,
            tools: group.tools.filter((tool) => {
              const key = JSON.stringify(tool.source);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }),
          }))
          .filter((group) => group.narration || group.tools.length),
      };
    });
    const notices = [...new Set(warnings)];
    const result = {
      id,
      revision: executionHash([unique, notices]),
      complete: notices.length === 0,
      warnings: notices,
      modules: unique,
    };
    this.previous = result;
    return result;
  }
}
