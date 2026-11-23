/** 当前账号总览；团队余额始终沿用单查的服务端权限。@author xiuyu.yi */
import {
  checkReadResults,
  listWorkspaces,
  managesWorkspace,
  readContacts,
  workspaceSummary,
  throwIfReadMustStop,
  type UserWorkspace,
} from './account-query-api.js';
import { BillQueryApi } from './bill-query-api.js';
import { CliError } from '../output/exit-codes.js';
import type { ApiClient } from '../transport/api-client.js';

async function readBalance(bills: BillQueryApi, team?: UserWorkspace) {
  const value = team ? await bills.workspaceBalance(team) : await bills.balance();
  return { status: 'AVAILABLE', currency: 'GLOW_TOKEN', amountUnit: 'credit', ...value };
}

function failedBalance(reason: unknown) {
  if (reason instanceof CliError && reason.details.authFailure === 'ACCESS_DENIED')
    return { status: 'FORBIDDEN', message: reason.message };
  return { status: 'UNAVAILABLE' };
}

export async function readAccountOverview(client: ApiClient) {
  const bills = new BillQueryApi(client);
  const [contacts, personal, teams] = await Promise.allSettled([
    readContacts(client),
    readBalance(bills),
    listWorkspaces(client),
  ]);
  checkReadResults([contacts, personal, teams]);

  const { state: contactState, ...user } =
    contacts.status === 'fulfilled'
      ? contacts.value
      : {
          state: 'PARTIAL',
          email: { status: 'UNAVAILABLE' },
          phone: { status: 'UNAVAILABLE' },
        };
  const account = {
    scope: 'personal',
    ...(personal.status === 'fulfilled' ? personal.value : failedBalance(personal.reason)),
  };
  const overview = { user, account };
  let complete = contactState === 'COMPLETED' && personal.status === 'fulfilled';
  if (teams.status === 'rejected')
    return { ...overview, state: 'PARTIAL', workspaceListStatus: 'UNAVAILABLE' };

  const managedTeams = teams.value.filter(managesWorkspace);
  if (managedTeams.length === 0)
    return { ...overview, state: complete ? 'COMPLETED' : 'PARTIAL', workspaces: [] };

  const balances = new Map<
    string,
    Awaited<ReturnType<typeof readBalance>> | ReturnType<typeof failedBalance>
  >();
  const batchSize = 4;
  for (let i = 0; i < managedTeams.length; i += batchSize) {
    await Promise.all(
      managedTeams.slice(i, i + batchSize).map(async (team) => {
        try {
          balances.set(team.workspaceId, await readBalance(bills, team));
        } catch (error) {
          throwIfReadMustStop(error);
          balances.set(team.workspaceId, failedBalance(error));
        }
      }),
    );
  }

  // 出参按最新名单组装；复核失败时丢弃已读取的团队金额。
  let current: UserWorkspace[];
  try {
    current = await listWorkspaces(client);
  } catch (error) {
    throwIfReadMustStop(error);
    if (contacts.status === 'rejected' && personal.status === 'rejected') throw error;
    return { ...overview, state: 'PARTIAL', workspaceListStatus: 'UNAVAILABLE' };
  }
  const workspaces = current.filter(managesWorkspace).map((team) => {
    const balance = balances.get(team.workspaceId) ?? { status: 'UNAVAILABLE' };
    if (balance.status !== 'AVAILABLE') complete = false;
    return { ...workspaceSummary(team), balance };
  });
  return { ...overview, state: complete ? 'COMPLETED' : 'PARTIAL', workspaces };
}
