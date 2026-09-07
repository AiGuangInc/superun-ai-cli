/** 未发布源码包的调试入口。@author xiuyu.yi */
import { PACKAGE_PRIVATE, PACKAGE_VERSION } from './config/constants.js';
import { OutputWriter } from './output/writer.js';
import { CliError } from './output/exit-codes.js';
import { runCli } from './runner.js';
const output = new OutputWriter();
if (!PACKAGE_PRIVATE)
  process.exitCode = output.fail(new CliError('INVALID_ARGUMENT', '发行包不提供开发入口'));
else {
  output.log('当前为源码开发模式；发行入口始终执行版本检查。');
  process.exitCode = await runCli(process.argv.slice(2), {
    output,
    checkVersion: async () => ({ reexecuted: false, version: PACKAGE_VERSION }),
  });
}
