/** 未知接口字段的窄化工具。@author xiuyu.yi */
import { CliError } from '../output/exit-codes.js';

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
export function list(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : [];
}
export function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CliError('INVALID_ARGUMENT', `${field} 不能为空`);
  return value;
}
export function enabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}
