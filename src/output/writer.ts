/** stdout 单结果输出，敏感值统一脱敏。@author xiuyu.yi */
import { SCHEMA_VERSION } from '../config/constants.js';
import type { CreationResult } from '../contracts/cli-output.js';
import { CliError, EXIT_CODES } from './exit-codes.js';

const SENSITIVE_KEY =
  /^(?:pat|token|access[-_]?token|private[-_]?token|gatewayToken|authorization|password|secret|secrets|secretValues|apiKey|api_key|rowKey|authToken)$/i;

export class OutputWriter {
  private written = false;
  private readonly secrets = new Set<string>();

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

  /** stderr 输出过程事件，stdout 仍只输出一次最终结果。 */
  progress(data: Pick<CreationResult, 'sessionId' | 'messageId' | 'taskProgress'>): void {
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
        instruction:
          '展示 data.taskProgress.markdown 中的全部任务进度；按卡片 id 更新，避免重复展示。这是过程更新，继续等待当前命令的最终结果，不代表整个任务结束，不重复提交任务。',
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
        code: failure.code,
        message: failure.message,
      },
    });
    return EXIT_CODES[failure.code];
  }

  private emit(value: unknown): void {
    if (this.written) return;
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
