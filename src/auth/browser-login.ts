/** 复用 Glow 浏览器登录凭据，领取并保存 PAT。@author xiuyu.yi */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeConfig } from '../config/runtime-config.js';
import { DEFAULT_ENDPOINT } from '../config/constants.js';
import { CliError } from '../output/exit-codes.js';
import type { OutputWriter } from '../output/writer.js';
import { ApiClient } from '../transport/api-client.js';
import { PatStore, validatePat } from './pat-store.js';
import type { PatCredential } from './pat-store.js';

async function openBrowser(url: string, signal: AbortSignal): Promise<boolean> {
  const [command, args]: [string, Array<string>] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: 'ignore',
      timeout: 10_000,
      signal,
    });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

export async function ensurePat(options: {
  store: PatStore;
  config: RuntimeConfig;
  output: OutputWriter;
  signal: AbortSignal;
  allowBrowser: boolean;
}): Promise<PatCredential> {
  const { store, config, output, signal: commandSignal, allowBrowser } = options;
  const existing = await store.readIfPresent();
  if (existing) return existing;
  if (!allowBrowser)
    throw new CliError(
      'AUTH_REQUIRED',
      '未配置 PAT，请执行 superun-ai auth login；脚本中请设置 SUPERUN_PAT 或使用 auth login --stdin',
    );
  // 认证统一使用 Superun 站点，业务地址不影响登录与凭据签发。
  const loginConfig = { ...config, endpoint: DEFAULT_ENDPOINT };
  const uuid = randomUUID();
  const loginUrl = new URL('/web/cli-token-callback', loginConfig.endpoint);
  loginUrl.searchParams.set('uuid', uuid);
  const timeout = AbortSignal.timeout(300_000);
  const signal = AbortSignal.any([commandSignal, timeout]);
  try {
    signal.throwIfAborted();
    output.log(`请在浏览器完成 Superun 登录：${loginUrl.href}`);
    if (!(await openBrowser(loginUrl.href, signal))) output.log('未能自动打开浏览器，请手动打开上面的地址。');
    const anonymousClient = new ApiClient(loginConfig, '', undefined, signal);
    while (true) {
      signal.throwIfAborted();
      // 领取接口会删除已返回的 Token，因此按写请求处理，禁止自动重试。
      const token = await anonymousClient.call(
        '/api/uxa-center/support/UserAccount/pollCliToken',
        { uuid },
        true,
      );
      if (token === null || token === undefined || token === '') {
        await delay(2000, undefined, { signal });
        continue;
      }
      if (typeof token !== 'string') throw new CliError('PROTOCOL_ERROR', '网页登录未返回有效 Token');
      output.registerSecret(token);
      const client = new ApiClient(loginConfig, token, undefined, signal);
      const issued = await client.call('/api/uxa-center/support/PersonalAccessToken/create', {}, true);
      if (typeof issued !== 'string') throw new CliError('PROTOCOL_ERROR', '未取得有效 PAT');
      output.registerSecret(issued);
      const pat = validatePat(issued);
      signal.throwIfAborted();
      await store.save(pat);
      output.log('登录成功，PAT 已保存到本地。');
      return { pat, source: 'file' };
    }
  } catch (error) {
    if (commandSignal.aborted) throw new CliError('INTERRUPTED', '已取消登录');
    if (timeout.aborted)
      throw new CliError('AUTH_REQUIRED', '网页登录等待超时，请重新执行 superun-ai auth login');
    throw error;
  }
}
