/** 复用 Glow 浏览器登录凭据，领取并保存 PAT。@author xiuyu.yi */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeConfig } from '../config/runtime-config.js';
import { DEFAULT_ENDPOINT } from '../config/constants.js';
import { object, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import type { OutputWriter } from '../output/writer.js';
import { ApiClient } from '../transport/api-client.js';
import { PatStore, validatePat } from './pat-store.js';
import type { PatCredential } from './pat-store.js';
import { isCredentialRejected, verifyCredential } from './credential-status.js';

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
  verifyExisting?: boolean;
  name: string;
}): Promise<PatCredential> {
  const { store, config, output, signal: commandSignal, allowBrowser, name } = options;
  const existing = await store.readIfPresent();
  if (existing) {
    output.registerSecret(existing.pat);
    if (!options.verifyExisting) return existing;
    try {
      await verifyCredential(new ApiClient(config, existing.pat, undefined, commandSignal));
      return existing;
    } catch (error) {
      if (!isCredentialRejected(error)) throw error;
      if (existing.source === 'env')
        throw new CliError('AUTH_REQUIRED', 'SUPERUN_PAT 已被拒绝，请更新或移除该环境变量后重新登录', {
          authFailure: 'CREDENTIAL_REJECTED',
          credentialSource: 'env',
        });
      if (config.endpoint !== DEFAULT_ENDPOINT)
        throw new CliError('AUTH_REQUIRED', '目标环境拒绝了当前 PAT，请核对 endpoint 与对应环境的凭据', {
          authFailure: 'CREDENTIAL_REJECTED',
          credentialSource: 'file',
        });
      // 旧凭据先保留，只有完整网页登录成功后才原子替换。
    }
  }
  if (!allowBrowser)
    throw new CliError(
      'AUTH_REQUIRED',
      '未配置 PAT，请执行 superun-ai auth login；脚本中请设置 SUPERUN_PAT 或使用 auth login --stdin',
    );
  // 认证统一使用 superun 站点，业务地址不影响登录与凭据签发。
  const loginConfig = { ...config, endpoint: DEFAULT_ENDPOINT };
  const uuid = randomUUID();
  const loginUrl = new URL('/web/cli-token-callback', loginConfig.endpoint);
  loginUrl.searchParams.set('uuid', uuid);
  const timeout = AbortSignal.timeout(300_000);
  const signal = AbortSignal.any([commandSignal, timeout]);
  try {
    signal.throwIfAborted();
    output.log(`请在浏览器完成 superun 登录：${loginUrl.href}`);
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
      const issued = await client.call(
        '/api/uxa-center/support/PersonalAccessToken/createWithOptions',
        // 沿用原 CLI 创建令牌的 365 天有效期。
        { name, expireDays: 365 },
        true,
      );
      const issuedToken = text(object(issued).token);
      if (!issuedToken) throw new CliError('PROTOCOL_ERROR', '未取得有效 PAT');
      output.registerSecret(issuedToken);
      const pat = validatePat(issuedToken);
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
