/** API 连接与公共请求头。@author xiuyu.yi */
import type { RuntimeConfig } from '../config/runtime-config.js';
import { PACKAGE_NAME } from '../config/constants.js';
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
    return this.http.request({
      url: `${this.config.endpoint}${path}`,
      method: options.method ?? 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'access-token': this.pat,
        'prefer-language': this.config.locale,
        'request-source': PACKAGE_NAME,
        'x-superun-client': 'cli',
        'x-superun-host': 'superun.com',
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
