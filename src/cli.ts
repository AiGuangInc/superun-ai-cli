#!/usr/bin/env node
/** superun-ai 发行入口。@author xiuyu.yi */
import { PACKAGE_PRIVATE } from './config/constants.js';
import { runCli } from './runner.js';

// 私有开发包支持本地安装测试，正式发行包执行版本检查。
if (PACKAGE_PRIVATE) await import('./development.js');
else process.exitCode = await runCli(process.argv.slice(2));
