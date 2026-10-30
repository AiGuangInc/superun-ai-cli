/** Windows 凭据使用系统 ACL，不把 POSIX mode 当作权限依据。@author xiuyu.yi */
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { CliError } from '../output/exit-codes.js';

const execute = promisify(execFile);

// 只传文件路径，不向 PowerShell 传递 PAT、用户配置或业务环境变量。
async function credentialAcl(path: string, protect: boolean): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !win32.isAbsolute(systemRoot))
    throw new CliError('AUTH_REQUIRED', '无法定位 Windows 系统权限工具，不能安全读写本地 PAT');
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $path = $env:SUPERUN_CREDENTIAL_ACL_PATH
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $sidType = [System.Security.Principal.SecurityIdentifier]
  ${
    protect
      ? `
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $user, [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Microsoft.PowerShell.Security\\Set-Acl -LiteralPath $path -AclObject $acl
  `
      : ''
  }
  $acl = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $path
  if ($acl.GetOwner($sidType).Value -ne $user.Value) { exit 2 }
  $allowed = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
  $hasUser = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    if ($allowed -notcontains $rule.IdentityReference.Value) { exit 2 }
    if ($rule.IdentityReference.Value -eq $user.Value) { $hasUser = $true }
  }
  if (-not $hasUser) { exit 2 }
  [Console]::Out.Write('SUPERUN_ACL_OK')
} catch { exit 1 }
`;
  try {
    const { stdout } = await execute(
      win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        shell: false,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4096,
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, SUPERUN_CREDENTIAL_ACL_PATH: path },
      },
    );
    if (stdout.trim() !== 'SUPERUN_ACL_OK') throw new Error('ACL_CHECK_FAILED');
  } catch {
    throw new CliError(
      'AUTH_REQUIRED',
      protect
        ? '无法安全设置 Windows 凭据 ACL，未保存 PAT；请检查当前用户的文件权限'
        : 'Windows 凭据 ACL 校验未通过；仅允许当前用户、SYSTEM 和本机管理员访问，请核对权限或重新导入凭据',
      { authFailure: 'CREDENTIAL_PERMISSION_DENIED' },
    );
  }
}

export const protectWindowsCredential = (path: string): Promise<void> => credentialAcl(path, true);
export const verifyWindowsCredential = (path: string): Promise<void> => credentialAcl(path, false);
