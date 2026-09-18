/** 命令输入、连接上下文与结果等待。@author xiuyu.yi */
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import { z } from 'zod';
import { PatStore } from '../auth/pat-store.js';
import { ensurePat } from '../auth/browser-login.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { ApiClient } from '../transport/api-client.js';
import { CreationRuntime } from '../runtime.js';
import type { OutputWriter } from '../output/writer.js';
import { CliError } from '../output/exit-codes.js';
import { object, text } from '../contracts/value.js';
import { creditCode } from '../conversation/insufficient-credits.js';
import type { JsonObject } from '../contracts/value.js';
import { SessionBinding } from '../session/binding.js';
import { detectHostContext } from '../session/host-context.js';

export type CommandContext = {
  output: OutputWriter;
  patStore: PatStore;
  signal: AbortSignal;
  makeRuntime?: (config: ReturnType<typeof runtimeConfig>, pat: string) => CreationRuntime;
  connection?: Promise<CredentialContext>;
  sessionBinding?: Promise<SessionBinding | undefined>;
  selectedSessionId?: string;
};
export type CredentialContext = {
  service: CreationRuntime;
  credentialSource: 'env' | 'file';
};

async function loadCredentialContext(
  context: CommandContext,
  command: Command,
  allowBrowser: boolean,
): Promise<CredentialContext> {
  const options = object(command.optsWithGlobals());
  const config = runtimeConfig({
    endpoint: text(options.endpoint),
    locale: text(options.locale),
  });
  const credential = await ensurePat({
    store: context.patStore,
    config,
    output: context.output,
    signal: context.signal,
    allowBrowser,
  });
  context.output.registerSecret(credential.pat);
  const service =
    context.makeRuntime?.(config, credential.pat) ??
    new CreationRuntime(new ApiClient(config, credential.pat, undefined, context.signal), context.output);
  return { service, credentialSource: credential.source };
}

/** 已有 PAT 直接复用；允许浏览器登录时自动补齐缺失的凭据。 */
export async function requireCredentials(
  context: CommandContext,
  command: Command,
  allowBrowser = false,
): Promise<CredentialContext> {
  context.connection ??= loadCredentialContext(context, command, allowBrowser);
  return context.connection;
}

// 统一声明会改变当前项目选择的操作；查询和等待默认不改变绑定。
const projectOperations = new Set([
  'send',
  'test',
  'review',
  'stop',
  'retry',
  'demo',
  'develop',
  'style generate',
  'style append',
  'style retry',
  'style select',
  'interaction reply',
  'interaction skip',
  'plugin enable',
  'plugin disable',
  'publish start',
  'publish visibility',
]);
export async function runtime(context: CommandContext, command: Command): Promise<CreationRuntime> {
  const service = (await requireCredentials(context, command)).service;
  const path: string[] = [];
  let parent: Command | null = command;
  while (parent?.parent && parent.name() !== 'chat') {
    path.unshift(parent.name());
    parent = parent.parent;
  }
  const sessionId = command.processedArgs[0];
  if (parent?.name() === 'chat' && projectOperations.has(path.join(' ')) && typeof sessionId === 'string')
    await selectSession(context, service, sessionId);
  return service;
}
async function selectSession(context: CommandContext, service: CreationRuntime, sessionId: string) {
  if (context.selectedSessionId === sessionId) return;
  const binding = await sessionBinding(context, service);
  if (binding) await binding.select(service, sessionId);
  context.selectedSessionId = sessionId;
}
/** 绑定归属仅在公共层识别一次；宿主未提供可靠身份时保留显式调用能力。 */
export async function sessionBinding(context: CommandContext, service: CreationRuntime) {
  context.sessionBinding ??= detectHostContext().then((host) =>
    host ? SessionBinding.connect(service, host) : undefined,
  );
  return context.sessionBinding;
}
export function positive(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new InvalidArgumentError('参数必须是正整数');
  return number;
}
export function waitOptions(command: Command): {
  timeout?: number;
  interval?: number;
  messageId?: string;
  progressRevision?: string;
} {
  const options = object(command.opts());
  return {
    timeout: typeof options.timeout === 'number' ? options.timeout : undefined,
    interval: typeof options.interval === 'number' ? options.interval : undefined,
    messageId: text(options.messageId),
    progressRevision: text(options.progressRevision),
  };
}
export function withWait(command: Command, noWaitDescription = '服务端接受请求后立即返回'): Command {
  return command
    .option('--wait', '等待交互或终态', true)
    .option('--no-wait', noWaitDescription)
    .option('--timeout <seconds>', '本地等待上限；不传则持续等待', positive);
}
export async function readInput(path: string): Promise<JsonObject> {
  let content = '';
  if (path === '-') {
    for await (const chunk of process.stdin) {
      content += String(chunk);
      if (Buffer.byteLength(content) > 2_000_000)
        throw new CliError('INVALID_ARGUMENT', 'JSON 输入不能超过 2MB');
    }
  } else {
    try {
      content = await readFile(path, 'utf8');
    } catch {
      throw new CliError('INVALID_ARGUMENT', '无法读取输入文件');
    }
    if (Buffer.byteLength(content) > 2_000_000)
      throw new CliError('INVALID_ARGUMENT', 'JSON 输入不能超过 2MB');
  }
  try {
    const value: unknown = JSON.parse(content);
    return z.record(z.unknown()).parse(value);
  } catch {
    throw new CliError('INVALID_ARGUMENT', '输入必须是有效的 JSON 对象');
  }
}
export async function businessWrite(
  context: CommandContext,
  service: CreationRuntime,
  sessionId: string | undefined,
  action: () => Promise<unknown>,
): Promise<unknown> {
  const binding = await sessionBinding(context, service);
  if (!binding)
    context.output.log('宿主未提供可确认归属的会话身份，本次不会自动保存当前项目；仍可显式传入 sessionId。');
  if (binding && sessionId) await selectSession(context, service, sessionId);
  const revision = !sessionId ? await binding?.beginCreation() : undefined;
  let response: unknown;
  try {
    response = await action();
  } catch (error) {
    if (binding && revision) {
      const rejected =
        error instanceof CliError &&
        ['BUSINESS_ERROR', 'AUTH_REQUIRED', 'INVALID_ARGUMENT'].includes(error.code);
      await binding.finishCreation(revision, { state: rejected ? 'CREATE_FAILED' : 'CREATE_UNKNOWN' });
    }
    if (error instanceof CliError && creditCode(error.details.businessCode))
      throw new CliError(error.code, error.message, {
        ...error.details,
        sessionId,
        endpoint: service.client.config.endpoint,
        locale: service.client.config.locale,
      });
    if (error instanceof CliError && error.code === 'OUTCOME_UNKNOWN' && sessionId) {
      let observedState: unknown;
      try {
        observedState = await service.state(sessionId);
      } catch {
        /* 查询失败仍保留原始不确定结果。 */
      }
      throw new CliError('OUTCOME_UNKNOWN', '写请求结果不确定，已查询当前会话；请核对后再决定下一步', {
        ...error.details,
        sessionId,
        observedState,
        retryable: false,
      });
    }
    if (context.signal.aborted)
      throw new CliError('INTERRUPTED', '命令已中断，远端任务不受影响', { sessionId });
    throw error;
  }
  if (binding && revision) {
    const createdSessionId = text(object(response).sessionId);
    if (!createdSessionId) {
      await binding.finishCreation(revision, { state: 'CREATE_UNKNOWN' });
      throw new CliError('OUTCOME_UNKNOWN', '创建回执未包含 sessionId，请先核对结果，不要重复创建', {
        retryable: false,
      });
    }
    try {
      await binding.finishCreation(revision, { state: 'BOUND', sessionId: createdSessionId });
    } catch {
      throw new CliError(
        'PROTOCOL_ERROR',
        '项目已创建，但本地绑定保存失败；请保留 sessionId 继续查询，不要重复创建',
        {
          sessionId: createdSessionId,
          remoteAccepted: true,
          retryable: false,
        },
      );
    }
  }
  return response;
}
export async function pollOperation<T>(
  read: () => Promise<T>,
  isTerminal: (value: T) => boolean,
  options: { timeout?: number; signal?: AbortSignal },
): Promise<T> {
  const deadline =
    options.timeout === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.timeout * 1000;
  while (true) {
    const value = await read();
    if (isTerminal(value)) return value;
    if (Date.now() >= deadline)
      throw new CliError('LOCAL_WAIT_TIMEOUT', '本地等待超时，远端操作仍可能进行中');
    try {
      await delay(2000, undefined, { signal: options.signal });
    } catch {
      throw new CliError('INTERRUPTED', '已停止本地等待');
    }
  }
}
