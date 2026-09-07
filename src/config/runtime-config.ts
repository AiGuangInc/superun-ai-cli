/** 本次命令的连接配置。@author xiuyu.yi */
import { DEFAULT_ENDPOINT, PRE_ENDPOINT } from './constants.js';
import { CliError } from '../output/exit-codes.js';

export type RuntimeConfig = {
  endpoint: string;
  locale: string;
  timeoutMs: number;
  gatewayToken?: string;
};

function environmentEndpoint(environment: string): string {
  if (environment === 'pre') return PRE_ENDPOINT;
  if (environment === 'prod') return DEFAULT_ENDPOINT;
  throw new CliError('INVALID_ARGUMENT', 'env 必须为 prod 或 pre');
}

export function runtimeConfig(options: { endpoint?: string; locale?: string; env?: string }): RuntimeConfig {
  const endpoint =
    options.endpoint ??
    (options.env !== undefined
      ? environmentEndpoint(options.env)
      : (process.env.SUPERUN_ENDPOINT ?? environmentEndpoint(process.env.SUPERUN_ENV ?? 'prod')));
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CliError('INVALID_ARGUMENT', 'endpoint 必须为有效的 HTTP(S) 地址');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new CliError('INVALID_ARGUMENT', 'endpoint 只接受 HTTPS 源站地址；本机开发可使用 HTTP');
  }
  return {
    endpoint: url.origin,
    locale: options.locale ?? 'zh-CN',
    timeoutMs: 65_000,
    ...(url.origin === PRE_ENDPOINT ? { gatewayToken: process.env.PRIVATE_TOKEN?.trim() } : {}),
  };
}
