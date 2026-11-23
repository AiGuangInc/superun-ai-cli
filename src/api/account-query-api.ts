/** 当前登录用户的绑定联系方式及团队目录。@author xiuyu.yi */
import { z } from 'zod';
import { isCredentialRejected } from '../auth/credential-status.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';
import type { ApiClient } from '../transport/api-client.js';

const emailBinding = z.object({ bound: z.boolean(), email: z.string().nullish() });
const phoneBinding = z.object({
  bound: z.boolean(),
  phone: z.string().nullish(),
  areaCode: z.string().nullish(),
});
const workspaces = z.array(
  z.object({
    workspaceId: z.string().regex(/^[1-9]\d*$/),
    workspaceName: z.string(),
    role: z.string().min(1),
    isManager: z.boolean(),
  }),
);

export type UserWorkspace = z.infer<typeof workspaces>[number];

export function managesWorkspace(team: UserWorkspace): boolean {
  return team.isManager && (team.role === 'admin' || team.role === 'manager');
}

export function workspaceSummary({ workspaceId, workspaceName, role }: UserWorkspace) {
  return { workspaceId, workspaceName, role };
}

/** 账号查询的上游错误可能包含身份字段，对外只保留标准错误码与恢复信息。 */
export async function callAccountQuery(client: ApiClient, path: string, body: object = {}) {
  try {
    return await client.call(path, body);
  } catch (error) {
    if (isCredentialRejected(error))
      throw new CliError('AUTH_REQUIRED', '凭据已失效，请重新登录', error.details);
    if (!(error instanceof CliError)) throw error;
    if (String(error.details.businessCode) === '44002001')
      throw new CliError('AUTH_REQUIRED', '无权查看该账户信息', {
        authFailure: 'ACCESS_DENIED',
        businessCode: error.details.businessCode,
      });
    if (error.details.businessCode !== undefined)
      throw new CliError(error.code, '账户查询未成功', { businessCode: error.details.businessCode });
    throw error;
  }
}

async function readEmail(client: ApiClient) {
  const data = parseWire(
    emailBinding,
    await callAccountQuery(client, '/api/uxa-center/support/Support/checkEmailBound'),
  );
  if (!data.bound) return { status: 'UNBOUND' };
  const address = z.string().email().safeParse(data.email);
  if (!address.success) throw new CliError('PROTOCOL_ERROR', '未取得有效绑定邮箱');
  return { status: 'BOUND', address: address.data };
}

async function readPhone(client: ApiClient) {
  const data = parseWire(
    phoneBinding,
    await callAccountQuery(client, '/api/uxa-center/support/Support/checkPhoneBound'),
  );
  if (!data.bound) return { status: 'UNBOUND' };
  if (!data.phone?.trim()) throw new CliError('PROTOCOL_ERROR', '未取得绑定手机号');
  // 只透出约定的掩码格式。短号码及异常格式均不回显原文。
  const maskedNumber = /^\d{1,3}\*+\d{1,4}$/.test(data.phone) ? data.phone : '****';
  const areaCode = /^\+?\d{1,4}$/.test(data.areaCode ?? '') ? data.areaCode : undefined;
  return { status: 'BOUND', areaCode, maskedNumber };
}

/** HTTP 401 与本地中断必须让整条命令失败。权限不足或单项业务失败仍可部分返回。 */
export function throwIfReadMustStop(error: unknown): void {
  if (error instanceof CliError && (error.code === 'INTERRUPTED' || error.details.httpStatus === 401))
    throw error;
}

export function checkReadResults(results: PromiseSettledResult<unknown>[]) {
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const failure of failures) throwIfReadMustStop(failure.reason);
  const failure = failures.find((r) => isCredentialRejected(r.reason)) ?? failures[0];
  if (failure && failures.length === results.length) throw failure.reason;
}

export async function readContacts(client: ApiClient) {
  const [email, phone] = await Promise.allSettled([readEmail(client), readPhone(client)]);
  checkReadResults([email, phone]);
  return {
    state: email.status === 'fulfilled' && phone.status === 'fulfilled' ? 'COMPLETED' : 'PARTIAL',
    email: email.status === 'fulfilled' ? email.value : { status: 'UNAVAILABLE' },
    phone: phone.status === 'fulfilled' ? phone.value : { status: 'UNAVAILABLE' },
  };
}

export async function listWorkspaces(client: ApiClient) {
  return parseWire(
    workspaces,
    await callAccountQuery(client, '/api/uxa-center/agent/AgentWorkspace/queryUserWorkspaces'),
  );
}
