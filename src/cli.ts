#!/usr/bin/env node
/** superun-ai 发行入口。@author xiuyu.yi */
import { runCli } from './runner.js';
process.exitCode = await runCli(process.argv.slice(2));
