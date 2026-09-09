/** 本次命令的连接配置。@author xiuyu.yi */
import { DEFAULT_ENDPOINT } from './constants.js';
import { CliError } from '../output/exit-codes.js';

export type RuntimeConfig = {
  endpoint: string;
  locale: string;
  timeoutMs: number;
};

export function runtimeConfig(options: { endpoint?: string; locale?: string }): RuntimeConfig {
  const endpoint = options.endpoint ?? process.env.SUPERUN_ENDPOINT ?? DEFAULT_ENDPOINT;
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
  };
}
