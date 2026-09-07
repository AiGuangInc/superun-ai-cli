/** 进程生命周期与统一错误出口。@author xiuyu.yi */
import { CommanderError } from 'commander';
import { createProgram } from './program.js';
import { OutputWriter } from './output/writer.js';
import { CliError } from './output/exit-codes.js';
import { PatStore } from './auth/pat-store.js';
import { versionGate } from './update/version-gate.js';
import type { CommandContext } from './commands/shared.js';

class Reexecuted extends Error {
  constructor(readonly exitCode: number) {
    super('reexecuted');
  }
}
export type RunnerOptions = {
  output?: OutputWriter;
  patStore?: PatStore;
  makeRuntime?: CommandContext['makeRuntime'];
  checkVersion?: typeof versionGate;
};
export async function runCli(argv: Array<string>, options: RunnerOptions = {}): Promise<number> {
  const output = options.output ?? new OutputWriter(),
    controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const checkVersion = options.checkVersion ?? versionGate;
  const context: CommandContext = {
    output,
    signal: controller.signal,
    patStore: options.patStore ?? new PatStore(),
    makeRuntime: options.makeRuntime,
  };
  try {
    const program = createProgram(context, {
      beforeBusiness: async () => {
        const result = await checkVersion(argv, output);
        if (result.reexecuted) throw new Reexecuted(result.exitCode ?? 0);
      },
      update: () => versionGate(argv, output, true),
    });
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof Reexecuted) return error.exitCode;
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      return output.fail(new CliError('INVALID_ARGUMENT', error.message));
    }
    return output.fail(error);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
