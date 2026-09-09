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
import type { JsonObject } from '../contracts/value.js';

export type CommandContext = {
  output: OutputWriter;
  patStore: PatStore;
  signal: AbortSignal;
  makeRuntime?: (config: ReturnType<typeof runtimeConfig>, pat: string) => CreationRuntime;
  connection?: Promise<CredentialContext>;
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

export async function runtime(context: CommandContext, command: Command): Promise<CreationRuntime> {
  return (await requireCredentials(context, command)).service;
}
export function positive(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new InvalidArgumentError('参数必须是正整数');
  return number;
}
export function waitOptions(command: Command): { timeout?: number; interval?: number; messageId?: string } {
  const options = object(command.opts());
  return {
    timeout: typeof options.timeout === 'number' ? options.timeout : undefined,
    interval: typeof options.interval === 'number' ? options.interval : undefined,
    messageId: text(options.messageId),
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
  try {
    return await action();
  } catch (error) {
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
