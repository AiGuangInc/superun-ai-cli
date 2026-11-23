/** API 连接与公共请求头。@author xiuyu.yi */
import { createHash } from 'node:crypto';
import type { RuntimeConfig } from '../config/runtime-config.js';
import { PACKAGE_NAME } from '../config/constants.js';
import { requestChannel } from '../config/request-channel.js';
import { assertProjectWritable } from '../api/project-mode.js';
import { object, text } from '../contracts/value.js';
import { HttpClient } from './http-client.js';
import type { HttpResponse, HttpRequest } from './http-client.js';

export class ApiClient {
  constructor(
    readonly config: RuntimeConfig,
    private readonly pat: string,
    private readonly http = new HttpClient(),
    readonly signal?: AbortSignal,
  ) {}

  /** 限制单次等待的生命周期，同时保留原客户端的中断信号。 */
  withSignal(signal: AbortSignal): ApiClient {
    return new ApiClient(
      this.config,
      this.pat,
      this.http,
      this.signal ? AbortSignal.any([this.signal, signal]) : signal,
    );
  }

  get interactionScope(): string {
    return createHash('sha256').update(`${this.config.endpoint}\n${this.pat}`).digest('hex');
  }

  async request(
    path: string,
    body?: unknown,
    options: {
      write?: boolean;
      etag?: string;
      method?: 'GET' | 'POST';
      sessionId?: string;
      native?: boolean;
      timeoutMs?: number;
      retryRead?: boolean;
      jsonReviver?: HttpRequest['jsonReviver'];
    } = {},
  ): Promise<HttpResponse> {
    if (options.write) {
      const sessionId = options.sessionId ?? text(object(body).sessionId);
      if (sessionId) await assertProjectWritable(this, sessionId);
    }
    return this.http.request({
      url: `${this.config.endpoint}${path}`,
      method: options.method ?? 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'access-token': this.pat,
        'prefer-language': this.config.locale,
        'request-source': PACKAGE_NAME,
        'request-channel': requestChannel,
        'x-superun-client': 'cli',
        'x-superun-host': 'superun.com',
        ...(options.sessionId ? { 'X-Session-Id': options.sessionId } : {}),
        ...(options.etag ? { 'if-none-match': options.etag } : {}),
      },
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
      retryRead: options.retryRead,
      jsonReviver: options.jsonReviver,
      signal: this.signal,
      write: options.write,
      native: options.native,
    });
  }

  async call(path: string, body: unknown = {}, write = false): Promise<unknown> {
    return (await this.request(path, body, { write })).data;
  }
}
