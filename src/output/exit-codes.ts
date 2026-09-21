/** 对外错误与退出码。@author xiuyu.yi */
export const EXIT_CODES = {
  INVALID_ARGUMENT: 2,
  AUTH_REQUIRED: 3,
  UPDATE_REQUIRED: 4,
  UPDATE_FAILED: 4,
  VERSION_CHECK_FAILED: 4,
  BUSINESS_ERROR: 5,
  STALE_INTERACTION: 5,
  AMBIGUOUS_INTERACTION: 5,
  OUTCOME_UNKNOWN: 5,
  UNSUPPORTED_INTERACTION: 6,
  LOCAL_WAIT_TIMEOUT: 7,
  PROTOCOL_ERROR: 8,
  LOCAL_STATE_PERMISSION_DENIED: 9,
  LOCAL_STATE_IO_ERROR: 9,
  LOCAL_STATE_LOCKED: 9,
  LOCAL_STATE_RECOVERY_REQUIRED: 9,
  INTERRUPTED: 130,
} as const;

export type ErrorCode = keyof typeof EXIT_CODES;

export class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CliError';
  }
}
