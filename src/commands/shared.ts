/** 命令输入、连接上下文与结果等待。@author xiuyu.yi */
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import { z } from 'zod';
import { PatStore } from '../auth/pat-store.js';
import { ensurePat } from '../auth/browser-login.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { requestChannel } from '../config/request-channel.js';
import { ApiClient } from '../transport/api-client.js';
import { CreationRuntime } from '../runtime.js';
import type { OutputWriter } from '../output/writer.js';
import { CliError } from '../output/exit-codes.js';
import { object, text } from '../contracts/value.js';
import { creditCode } from '../conversation/insufficient-credits.js';
import type { JsonObject } from '../contracts/value.js';
import { SessionBinding } from '../session/binding.js';
import { detectHostContext } from '../session/host-context.js';
import { scheduleRemember } from '../session/remember.js';

export type CommandContext = {
  output: OutputWriter;
  patStore: PatStore;
  signal: AbortSignal;
  makeRuntime?: (config: ReturnType<typeof runtimeConfig>, pat: string) => CreationRuntime;
  connection?: Promise<CredentialContext>;
  sessionBinding?: Promise<SessionBinding | undefined>;
  selectedSessionId?: string;
  selectionRequestedAt?: string;
  rememberSession?: (sessionId: string, requestedAt: string, creationRevision?: string) => void;
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
    name: text(options.name) ?? requestChannel,
  });
  context.output.registerSecret(credential.pat);
  const service =
    context.makeRuntime?.(config, credential.pat) ??
    new CreationRuntime(new ApiClient(config, credential.pat, undefined, context.signal), context.output);
  context.rememberSession = (sessionId, requestedAt, creationRevision) =>
    scheduleRemember({
      sessionId,
      requestedAt,
      endpoint: config.endpoint,
      locale: config.locale,
      credentialScope: service.client.interactionScope,
      ...(creationRevision ? { creationRevision } : {}),
    });
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
  'security',
  'agent-friendly',
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
  return (await requireCredentials(context, command)).service;
}

/** 命令分发时启动后台保存；显式项目不读取本地绑定，也不等待辅助保存。 */
export function rememberExplicitSession(context: CommandContext, command: Command): void {
  const path: string[] = [];
  let parent: Command | null = command;
  while (parent?.parent && parent.name() !== 'chat') {
    path.unshift(parent.name());
    parent = parent.parent;
  }
  const sessionId = command.processedArgs[0];
  const options = object(command.opts());
  if (path.join(' ') === 'agent-friendly' && (options.status || options.method || options.messageId)) return;
  if (
    parent?.name() !== 'chat' ||
    !projectOperations.has(path.join(' ')) ||
    typeof sessionId !== 'string' ||
    context.selectedSessionId === sessionId ||
    !context.selectionRequestedAt ||
    context.signal.aborted
  )
    return;
  context.selectedSessionId = sessionId;
  context.rememberSession?.(sessionId, context.selectionRequestedAt);
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
  reviewId?: string;
} {
  const options = object(command.opts());
  return {
    timeout: typeof options.timeout === 'number' ? options.timeout : undefined,
    interval: typeof options.interval === 'number' ? options.interval : undefined,
    messageId: text(options.messageId),
    progressRevision: text(options.progressRevision),
    reviewId: text(options.reviewId),
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
  const binding = sessionId ? undefined : await sessionBinding(context, service);
  if (!sessionId && !binding)
    context.output.log('宿主未提供可确认归属的会话身份，本次不会自动保存当前项目；仍可显式传入 sessionId。');
  if (sessionId) context.selectedSessionId = sessionId;
  const revision = !sessionId ? await binding?.beginCreation(context.selectionRequestedAt) : undefined;
  let response: unknown;
  try {
    response = await action();
  } catch (error) {
    if (binding && revision) {
      const rejected =
        error instanceof CliError &&
        ['BUSINESS_ERROR', 'AUTH_REQUIRED', 'INVALID_ARGUMENT'].includes(error.code);
      try {
        await binding.finishCreation(revision, rejected ? 'CREATE_FAILED' : 'CREATE_UNKNOWN');
      } catch {
        // 原 CREATING 仍阻止重复提交，不能用清理异常覆盖业务错误。
      }
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
  if (!sessionId) {
    const createdSessionId = text(object(response).sessionId);
    if (!createdSessionId) {
      if (binding && revision) {
        try {
          await binding.finishCreation(revision, 'CREATE_UNKNOWN');
        } catch {
          // 保留未决创建保护，不覆盖缺少回执 ID 的原始结论。
        }
      }
      throw new CliError('OUTCOME_UNKNOWN', '创建回执未包含 sessionId，请先核对结果，不要重复创建', {
        retryable: false,
      });
    }
    // 已拿到真实项目 ID：返回业务回执，绑定及保护记录收尾交给后台处理。
    context.rememberSession?.(
      createdSessionId,
      context.selectionRequestedAt ?? new Date().toISOString(),
      revision,
    );
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
