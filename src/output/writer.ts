/** stdout 单结果输出，敏感值统一脱敏。@author xiuyu.yi */
import { SCHEMA_VERSION } from '../config/constants.js';
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
    const serialized = JSON.stringify(value, (key, item: unknown) =>
      SENSITIVE_KEY.test(key) ? undefined : typeof item === 'string' ? this.redact(item) : item,
    );
    this.stdout(`${this.redact(serialized)}\n`);
  }
}
