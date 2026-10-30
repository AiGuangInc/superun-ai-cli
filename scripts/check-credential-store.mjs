// 在隔离目录验证真实系统的凭据读写与权限拒绝，不访问用户凭据。@author xiuyu.yi
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {PatStore} from '../dist/auth/pat-store.js';

const execute = promisify(execFile);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'superun-credential-smoke-'));
const directory = path.join(temporary, '隔离 凭据');
const credential = path.join(directory, 'credentials.json');
const originalPat = process.env.SUPERUN_PAT;
const originalSystemRoot = process.env.SystemRoot;
const checks = [];
const denied = error => error?.code === 'AUTH_REQUIRED';
try {
  delete process.env.SUPERUN_PAT;
  const store = new PatStore(directory);
  assert.equal(await store.readIfPresent(), undefined);
  await store.save('sup_pat_SmokeSyntheticFirst');
  assert.deepEqual(await store.read(), {pat: 'sup_pat_SmokeSyntheticFirst', source: 'file'});
  await store.save('sup_pat_SmokeSyntheticReplacement');
  assert.equal((await store.read()).pat, 'sup_pat_SmokeSyntheticReplacement');
  checks.push('真实文件保存、读取及原子替换');

  if (process.platform === 'win32') {
    // 只向临时合成凭据添加 Everyone 读取权限，验证 CLI 会拒绝宽权限。
    const script = `
$ErrorActionPreference = 'Stop'
$acl = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:SUPERUN_SMOKE_FILE
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone, [System.Security.AccessControl.FileSystemRights]::Read,
  [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Microsoft.PowerShell.Security\\Set-Acl -LiteralPath $env:SUPERUN_SMOKE_FILE -AclObject $acl
`;
    await execute(path.win32.join(originalSystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {shell: false, windowsHide: true, timeout: 15000,
        env: {SystemRoot: originalSystemRoot, WINDIR: originalSystemRoot, SUPERUN_SMOKE_FILE: credential}});
    await assert.rejects(store.read(), denied);
    checks.push('真实 Windows ACL 宽权限拒绝');
    await store.save('sup_pat_SmokeSyntheticRecovered');
    assert.equal((await store.read()).pat, 'sup_pat_SmokeSyntheticRecovered');
    checks.push('重新保存后 ACL 恢复并可读取');

    const previous = await fs.readFile(credential);
    process.env.SystemRoot = path.join(temporary, 'missing-system');
    await assert.rejects(store.read(), denied);
    await assert.rejects(store.save('sup_pat_SmokeSyntheticMustNotSave'), denied);
    assert.deepEqual(await fs.readFile(credential), previous);
    assert.deepEqual(await fs.readdir(directory), ['credentials.json']);
    process.env.SystemRoot = originalSystemRoot;
    checks.push('ACL 工具失败时停止、保留旧凭据并清理临时文件');
  } else {
    assert.equal((await fs.stat(credential)).mode & 0o777, 0o600);
    await fs.chmod(credential, 0o644);
    await assert.rejects(store.read(), denied);
    await store.save('sup_pat_SmokeSyntheticRecovered');
    checks.push('真实 POSIX 0600 及宽权限拒绝');
  }

  process.env.SUPERUN_PAT = 'sup_pat_SmokeSyntheticEnvironment';
  assert.deepEqual(await store.read(), {pat: 'sup_pat_SmokeSyntheticEnvironment', source: 'env'});
  delete process.env.SUPERUN_PAT;
  await store.clear();
  assert.equal(await store.readIfPresent(), undefined);
  checks.push('环境凭据优先级及清除');
  console.log(JSON.stringify({platform: process.platform, checks, status: 'PASS'}));
} finally {
  if (originalPat === undefined) delete process.env.SUPERUN_PAT;
  else process.env.SUPERUN_PAT = originalPat;
  if (originalSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = originalSystemRoot;
  await fs.rm(temporary, {recursive: true, force: true});
}
