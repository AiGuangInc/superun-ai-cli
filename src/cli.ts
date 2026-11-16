#!/usr/bin/env node
/** superun-ai 发行入口。@author xiuyu.yi */
import { PACKAGE_PRIVATE, PACKAGE_VERSION } from './config/constants.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activeEntry, installationRoot } from './update/installation.js';

// 私有开发包支持本地安装测试，正式发行包执行版本检查。
if (PACKAGE_PRIVATE) await import('./development.js');
else {
  const { root } = await installationRoot();
  const active = await activeEntry(root, { minimum: PACKAGE_VERSION });
  // 保留同版本或更新的已验证入口，避免 npm 更新后仍切回旧缓存。
  if (active && active !== fileURLToPath(import.meta.url)) await import(pathToFileURL(active).href);
  else {
    const { runCli } = await import('./runner.js');
    process.exitCode = await runCli(process.argv.slice(2));
  }
}
