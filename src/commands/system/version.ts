/** 显示本地版本与输出协议版本。@author xiuyu.yi */
import type { Command } from 'commander';
import { PACKAGE_VERSION, SCHEMA_VERSION } from '../../config/constants.js';
import type { OutputWriter } from '../../output/writer.js';

export function registerVersion(program: Command, output: OutputWriter): void {
  program
    .command('version')
    .description('显示本地版本、输出协议及能力声明')
    .action(() =>
      output.write({
        version: PACKAGE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        // 只声明客户端实现契约，具体项目仍须每次实时预检。
        capabilities: [
          'project-mainline-check-preflight-v1',
          'current-mainline-publish-v1',
          'current-mainline-publish-v2',
          'security-scan-entry-v1',
          'ai-integration-entry-v1',
        ],
      }),
    );
}
