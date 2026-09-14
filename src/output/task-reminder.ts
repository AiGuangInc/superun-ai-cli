/** 任务进行中的通用定时提醒，由顶层输出管理生命周期。@author xiuyu.yi */
import { randomUUID } from 'node:crypto';

export type TaskReminderMessage = {
  id: string;
  message: string;
  url: string;
};

export class TaskReminder {
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly emit: (message: TaskReminderMessage) => void) {}

  start(): void {
    if (this.timer) return;
    const taskId = randomUUID();
    let sequence = 0;
    this.timer = setInterval(
      () => {
        try {
          this.emit({
            id: `${taskId}:${++sequence}`,
            message: '任务还在进行中，可以去 superun.ai 查看详情。',
            url: 'https://superun.ai',
          });
        } catch {
          // 提醒输出失败只停止提醒，不中断业务执行。
          this.stop();
        }
      },
      5 * 60 * 1000,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
