#!/usr/bin/env node
/** superun-ai 发行入口。@author xiuyu.yi */
import { PACKAGE_PRIVATE } from './config/constants.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activeEntry, installationRoot } from './update/installation.js';

// 私有开发包支持本地安装测试，正式发行包执行版本检查。
if (PACKAGE_PRIVATE) await import('./development.js');
else {
  const { root } = await installationRoot();
  const active = await activeEntry(root);
  // 在加载业务模块之前切换，帮助和离线 version 也使用已验证的新版本。
  if (active && active !== fileURLToPath(import.meta.url)) await import(pathToFileURL(active).href);
  else {
    const { runCli } = await import('./runner.js');
    process.exitCode = await runCli(process.argv.slice(2));
  }
}
