/** 在线核对 PAT，不读取或选择具体作品。@author xiuyu.yi */
import { object } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import type { ApiClient } from '../transport/api-client.js';

export function isCredentialRejected(error: unknown): error is CliError {
  return (
    error instanceof CliError &&
    error.code === 'AUTH_REQUIRED' &&
    (error.details.httpStatus === 401 || String(error.details.businessCode) === '1000011')
  );
}

export async function verifyCredential(client: ApiClient): Promise<void> {
  const response = object(
    await client.call('/api/uxa-center/agent/AgentQuery/pageQuerySessionByLastId', {
      pageSize: 1,
      modes: [6],
      scopes: ['mine'],
    }),
  );
  // 空列表同样是有效登录；只校验结构，不输出列表或改变项目绑定。
  if (![response.data, response.items, response.list].some(Array.isArray))
    throw new CliError('PROTOCOL_ERROR', '登录校验未返回有效分页结构，请稍后重试');
}
