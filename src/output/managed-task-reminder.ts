/** 全托管提醒沿同一次运行的游标接续，不使用单进程计时。@author xiuyu.yi */
import { object } from '../contracts/value.js';
import type { TaskReminderMessage } from './task-reminder.js';

const INTERVAL_MS = 5 * 60 * 1000;
export const MANAGED_PROGRESS_GUIDE = {
  message: '全托管已启动，你也可以前往 superun.ai 查看制作进度。',
  url: 'https://superun.ai',
};

export function managedTaskReminder(
  sessionId: string,
  runId: string,
  startedAt: number | undefined,
  previous: unknown,
  now = Date.now(),
) {
  const saved = object(previous);
  const validStart = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= now;
  const origin = validStart(saved.startedAt) ? saved.startedAt : validStart(startedAt) ? startedAt : now;
  const lastSequence =
    origin === saved.startedAt && Number.isSafeInteger(saved.sequence) && Number(saved.sequence) >= 0
      ? Number(saved.sequence)
      : 0;
  const sequence = Math.floor((now - origin) / INTERVAL_MS);
  const cursor = { startedAt: origin, sequence: Math.max(lastSequence, sequence) };
  // 恢复时只提醒当前时间段，不连续补发离线期间错过的提醒。
  const message: TaskReminderMessage | undefined =
    sequence > lastSequence
      ? {
          id: `auto-mode:${sessionId}:${runId}:${origin}:${sequence}`,
          message: '任务还在进行中，可以去 superun.ai 查看详情。',
          url: MANAGED_PROGRESS_GUIDE.url,
        }
      : undefined;
  return { cursor, message };
}
