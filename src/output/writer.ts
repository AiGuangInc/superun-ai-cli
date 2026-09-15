/** stdout 单结果输出，敏感值统一脱敏。@author xiuyu.yi */
import { SCHEMA_VERSION } from '../config/constants.js';
import type { CreationResult } from '../contracts/cli-output.js';
import { CliError, EXIT_CODES } from './exit-codes.js';
import { TaskReminder } from './task-reminder.js';
import { creditFailureDetails } from '../conversation/insufficient-credits.js';

const SENSITIVE_KEY =
  /^(?:pat|token|access[-_]?token|private[-_]?token|gatewayToken|authorization|password|secret|secrets|secretValues|apiKey|api_key|rowKey|authToken)$/i;

export class OutputWriter {
  private written = false;
  private readonly secrets = new Set<string>();
  private readonly shownMessages = new Map<string, string>();
  private disposed = false;
  private readonly taskReminder = new TaskReminder((data) => {
    this.stderr(
      `${this.serialize({
        schemaVersion: SCHEMA_VERSION,
        event: 'task_reminder',
        data,
        instruction:
          '立即原样展示 data.message，将 superun.ai 链接到 data.url。同一 data.id 不重复展示；不同 ID 是每隔 5 分钟的再次提醒，文案相同也要展示。继续等待当前任务，不结束等待、不重新提交任务。',
      })}\n`,
    );
  });

  constructor(
    private readonly stdout: (text: string) => void = (text) => process.stdout.write(text),
    private readonly stderr: (text: string) => void = (text) => process.stderr.write(text),
  ) {}

  registerSecret(secret: string): void {
    if (secret) this.secrets.add(secret);
  }

  redact(text: string): string {
    let safe = text.replace(/sup_pat_[A-Za-z0-9_-]+/g, '[已隐藏]');
    for (const secret of this.secrets) safe = safe.split(secret).join('[已隐藏]');
    return safe;
  }

  log(text: string): void {
    this.stderr(`${this.redact(text)}\n`);
  }

  dispose(): void {
    this.disposed = true;
    this.taskReminder.stop();
  }

  startTaskReminder(): void {
    if (!this.written && !this.disposed) this.taskReminder.start();
  }

  /** stderr 输出过程事件，stdout 仍只输出一次最终结果。 */
  progress(
    data: Pick<CreationResult, 'sessionId' | 'messageId' | 'taskProgress'> &
      Partial<Pick<CreationResult, 'autoTest' | 'codeReview' | 'messages'>>,
  ): void {
    const checkName = data.codeReview ? '代码审查' : data.autoTest ? '自动测试' : undefined;
    if (checkName) {
      const messages =
        data.messages?.filter((message) => {
          if (message.role !== 'assistant' || !message.text.trim()) return false;
          const key = `${data.sessionId}:${message.id}`;
          if (this.shownMessages.get(key) === message.text) return false;
          this.shownMessages.set(key, message.text);
          return true;
        }) ?? [];
      if (messages.length)
        this.stderr(
          `${this.serialize({
            schemaVersion: SCHEMA_VERSION,
            event: 'conversation_message',
            data: { sessionId: data.sessionId, messageId: data.messageId, messages },
            instruction: `及时展示这些${checkName}或修复的实际对话消息，保留发现的问题与修复前告知；同一消息 id 更新正文，不重复追加。该事件只是过程，继续等待当前命令，不表示${checkName}或修复已全部完成，不展示继续创作或上线运营菜单。`,
          })}\n`,
        );
    }
    if (!data.taskProgress) return;
    this.stderr(
      `${this.serialize({
        schemaVersion: SCHEMA_VERSION,
        event: 'task_progress',
        data: {
          sessionId: data.sessionId,
          messageId: data.messageId,
          taskProgress: data.taskProgress,
        },
        instruction: checkName
          ? `展示 data.taskProgress.markdown 中实际任务进度，不把功能步骤数当作${checkName}的问题数或通过数。及时展示 conversation_message 中发现的问题和修复说明。继续等待当前命令的最终结果，不重复提交任务、不展示操作菜单。`
          : '每次查询都展示 data.taskProgress.markdown 中当前开发中的功能及步骤，即使 changed 为 false 也展示；不要从历史消息补回已完成的功能或旧步骤。支持原位更新时按卡片 id 更新，否则每次展示当前快照。不追加执行详情或工具次数。这是过程更新，继续等待当前命令的最终结果，不代表整个任务结束，不重复提交任务。',
      })}\n`,
    );
  }

  write(data: unknown): void {
    this.emit({ schemaVersion: SCHEMA_VERSION, ok: true, data });
  }

  fail(error: unknown): number {
    const failure =
      error instanceof CliError
        ? error
        : new CliError('PROTOCOL_ERROR', '命令执行失败，请检查网络与接口契约');
    this.emit({
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      error: {
        ...failure.details,
        ...creditFailureDetails(failure.details),
        code: failure.code,
        message: failure.message,
      },
    });
    return EXIT_CODES[failure.code];
  }

  private emit(value: unknown): void {
    if (this.written) return;
    this.dispose();
    this.written = true;
    this.stdout(`${this.serialize(value)}\n`);
  }

  private serialize(value: unknown): string {
    const serialized = JSON.stringify(value, (key, item: unknown) =>
      SENSITIVE_KEY.test(key) ? undefined : typeof item === 'string' ? this.redact(item) : item,
    );
    return this.redact(serialized);
  }
}
