/** API 连接与公共请求头。@author xiuyu.yi */
import type { RuntimeConfig } from '../config/runtime-config.js';
import { PRE_ENDPOINT } from '../config/constants.js';
import { CliError } from '../output/exit-codes.js';
import { HttpClient } from './http-client.js';
import type { HttpResponse } from './http-client.js';

export class ApiClient {
  constructor(
    readonly config: RuntimeConfig,
    private readonly pat: string,
    private readonly http = new HttpClient(),
    readonly signal?: AbortSignal,
  ) {}

  async request(
    path: string,
    body?: unknown,
    options: { write?: boolean; etag?: string; method?: 'GET' | 'POST' } = {},
  ): Promise<HttpResponse> {
    const requiresGatewayToken = this.config.endpoint === PRE_ENDPOINT;
    if (requiresGatewayToken && !this.config.gatewayToken) {
      throw new CliError(
        'AUTH_REQUIRED',
        '预发布环境需要 PRIVATE_TOKEN 网关凭据；业务登录仍使用 SUPERUN_PAT 或 auth login 保存的 PAT',
      );
    }
    return this.http.request({
      url: `${this.config.endpoint}${path}`,
      method: options.method ?? 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'access-token': this.pat,
        'prefer-language': this.config.locale,
        'request-source': 'superun-creation-cli',
        'x-superun-client': 'cli',
        'x-superun-host': 'superun.com',
        ...(requiresGatewayToken && this.config.gatewayToken
          ? { 'PRIVATE-TOKEN': this.config.gatewayToken }
          : {}),
        ...(options.etag ? { 'if-none-match': options.etag } : {}),
      },
      timeoutMs: this.config.timeoutMs,
      signal: this.signal,
      write: options.write,
    });
  }

  async call(path: string, body: unknown = {}, write = false): Promise<unknown> {
    return (await this.request(path, body, { write })).data;
  }
}
