/** HTTP 与业务响应信封处理；写请求只发送一次。@author xiuyu.yi */
import { CliError } from '../output/exit-codes.js';
import { object, text } from '../contracts/value.js';

export type HttpResponse = { status: number; etag?: string; data: unknown };
export type HttpRequest = {
  url: string;
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  write?: boolean;
};

export class HttpClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    const timeout = AbortSignal.timeout(request.timeoutMs ?? 65_000);
    const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(request.url, {
        method: request.method ?? 'POST',
        headers: request.headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal,
        redirect: 'error',
      });
    } catch {
      if (request.signal?.aborted) throw new CliError('INTERRUPTED', '已停止本地等待，远端任务不受影响');
      throw new CliError(
        request.write ? 'OUTCOME_UNKNOWN' : 'PROTOCOL_ERROR',
        request.write ? '请求结果不确定，请先查询服务端状态，勿重复提交' : '请求失败或超时',
        { retryable: !request.write },
      );
    }
    const etag = response.headers.get('etag') ?? undefined;
    if (response.status === 304) return { status: 304, etag, data: undefined };
    if (response.status === 401 || response.status === 403) {
      throw new CliError('AUTH_REQUIRED', 'PAT 无效或当前用户没有接口访问权限');
    }
    if (!response.ok)
      throw new CliError(
        request.write && response.status >= 500 ? 'OUTCOME_UNKNOWN' : 'PROTOCOL_ERROR',
        `接口返回 HTTP ${response.status}`,
        { httpStatus: response.status },
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CliError(request.write ? 'OUTCOME_UNKNOWN' : 'PROTOCOL_ERROR', '接口未返回有效 JSON');
    }
    const envelope = object(body);
    if ('code' in envelope) {
      if (String(envelope.code) !== '0') {
        throw new CliError(
          String(envelope.code) === '1000011' ? 'AUTH_REQUIRED' : 'BUSINESS_ERROR',
          text(envelope.msg) ?? text(envelope.message) ?? '接口返回业务错误',
          { businessCode: envelope.code },
        );
      }
      body = envelope.data;
    } else if (typeof envelope.success === 'boolean') {
      if (!envelope.success)
        throw new CliError(
          String(envelope.errorCode) === '1000011' ? 'AUTH_REQUIRED' : 'BUSINESS_ERROR',
          text(envelope.errorMessage) ?? '接口返回业务错误',
          { businessCode: envelope.errorCode },
        );
      body = envelope.data;
    }
    return { status: response.status, etag, data: body };
  }
}
