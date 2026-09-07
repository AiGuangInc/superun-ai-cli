/** 显示本地版本与输出协议版本。@author xiuyu.yi */
import type { Command } from 'commander';
import { PACKAGE_VERSION, SCHEMA_VERSION } from '../../config/constants.js';
import type { OutputWriter } from '../../output/writer.js';

export function registerVersion(program: Command, output: OutputWriter): void {
  program
    .command('version')
    .description('显示本地版本与输出协议版本')
    .action(() => output.write({ version: PACKAGE_VERSION, schemaVersion: SCHEMA_VERSION }));
}
