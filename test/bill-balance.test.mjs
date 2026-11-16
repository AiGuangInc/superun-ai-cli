import assert from 'node:assert/strict';
import test from 'node:test';
import { BillQueryApi } from '../dist/api/bill-query-api.js';

const path = '/api/uxa-center/support/UserAccount/queryAccount';

test('balance queries Glow and returns only the personal credit value', async () => {
  const calls = [];
  const api = new BillQueryApi({
    async call(requestPath, body) {
      calls.push([requestPath, body]);
      return {
        userCode: 'private',
        balances: [
          { currency: 'GLOW_TOKEN', ownerType: 'workspace', ownerId: '88', balanceStr: '900' },
          { currency: 'GLOW_TOKEN', ownerType: 'user', ownerId: '7', balanceStr: '12.34', secret: 'private' },
        ],
      };
    },
  });
  assert.deepEqual(await api.balance(), { balanceStr: '12.34' });
  assert.deepEqual(calls, [[path, { product: 13 }]]);
});

test('balance rejects missing or malformed personal values', async () => {
  for (const balances of [[], [{ currency: 'GLOW_TOKEN', ownerType: 'user', balanceStr: 'oops' }]]) {
    const api = new BillQueryApi({ async call() { return { balances }; } });
    await assert.rejects(() => api.balance(), { code: 'PROTOCOL_ERROR' });
  }
});
