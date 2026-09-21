/** 保留状态操作与清理失败的诊断信息，不输出状态内容。@author xiuyu.yi */
import { CliError } from '../output/exit-codes.js';

export function filesystemCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export async function stateOperation<T>(operation: string, path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = filesystemCode(error);
    const denied = code === 'EPERM' || code === 'EACCES';
    throw new CliError(
      denied ? 'LOCAL_STATE_PERMISSION_DENIED' : 'LOCAL_STATE_IO_ERROR',
      denied
        ? '本地状态目录权限不足，请检查所列路径的文件操作权限；不要重复提交业务请求'
        : '本地状态文件操作失败，请根据操作和路径排查；不要重复提交业务请求',
      { filesystemCode: code, operation, path },
    );
  }
}

/** 所有清理均尝试执行；清理异常不能覆盖首次异常。 */
export async function withStateCleanup<T>(
  run: () => Promise<T>,
  cleanup: Array<() => Promise<unknown>>,
): Promise<T> {
  let failed = false;
  let primary: unknown;
  let result: T;
  try {
    result = await run();
  } catch (error) {
    failed = true;
    primary = error;
  }
  const errors: CliError[] = [];
  for (const clean of cleanup) {
    try {
      await clean();
    } catch (error) {
      errors.push(
        error instanceof CliError ? error : new CliError('LOCAL_STATE_IO_ERROR', '本地状态清理失败'),
      );
    }
  }
  if (errors.length) {
    const first = failed
      ? primary instanceof CliError
        ? primary
        : new CliError('PROTOCOL_ERROR', '操作失败且本地状态清理失败，请保留现场排查')
      : errors.shift()!;
    throw new CliError(first.code, first.message, {
      ...first.details,
      ...(errors.length
        ? {
            cleanupErrors: [
              ...(Array.isArray(first.details.cleanupErrors) ? first.details.cleanupErrors : []),
              ...errors.map((error) => ({ ...error.details, code: error.code })),
            ],
          }
        : {}),
    });
  }
  if (failed) throw primary;
  return result!;
}
