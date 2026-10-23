/** 安全扫描独立入口的范围与主线门禁。@author xiuyu.yi */
import type { CreationRuntime } from '../runtime.js';
import type { SecurityReviewView } from '../contracts/security-review.js';
import type { SecurityReviewApi } from '../api/security-review-api.js';
import type { SessionView } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';
import { SecurityStatus } from '../contracts/security-review.js';
import { projectCheckPreflight } from './project-check-preflight.js';

type Catalog = Awaited<ReturnType<SecurityReviewApi['options']>>;
export function selectSecurityChecks(catalog: Catalog, requested: string[]): string[] {
  if (new Set(catalog.map((item) => item.category)).size !== catalog.length)
    throw new CliError('PROTOCOL_ERROR', '检查目录类别重复，未发起扫描');
  if (
    !requested.length &&
    catalog.some((item) => typeof item.available !== 'boolean' || typeof item.selectable !== 'boolean')
  )
    throw new CliError('PROTOCOL_ERROR', '检查目录状态不完整，无法确认全部可用项，未发起扫描');
  const selected = requested.length
    ? [...new Set(requested)]
    : catalog
        .filter((item) => item.available === true && item.selectable === true)
        .map((item) => item.category);
  if (!selected.length) throw new CliError('INVALID_ARGUMENT', '当前项目暂无明确可执行的安全检查项');
  for (const category of selected) {
    const item = catalog.find((row) => row.category === category);
    if (!item || item.available === false || item.selectable === false)
      throw new CliError('INVALID_ARGUMENT', '指定检查项当前不可用，请查询本项目检查目录', {
        checks: catalog,
      });
    if (item.available !== true || item.selectable !== true)
      throw new CliError('PROTOCOL_ERROR', '指定检查项的可用状态未知，未发起扫描');
  }
  return selected;
}

export async function securityStartPreflight(
  service: CreationRuntime,
  sessionId: string,
  expectedSource?: string,
  initialView?: SessionView,
) {
  const gate = await projectCheckPreflight(
    service,
    initialView ?? (await service.load(sessionId)),
    sessionId,
    '安全扫描',
  );
  if (gate.stage !== 'development')
    throw new CliError('INVALID_ARGUMENT', '当前仍是演示阶段，请先完成当前主线研发前置，再发起安全扫描', {
      sessionId,
    });
  if (gate.hasStaging)
    throw new CliError(
      'INVALID_ARGUMENT',
      '当前有未合并源码暂存，请先明确处理，再扫描研发主线；不会自动合并',
      { sessionId },
    );
  if (expectedSource && gate.sourceMessageId !== expectedSource)
    throw new CliError('STALE_INTERACTION', '扫描提交前主线已变化，请重新确认目标和范围', { sessionId });
  return gate;
}

export function assertExistingSecurityScope(review: SecurityReviewView, requested: string[]) {
  if (!requested.length) return;
  const categories = (review.checks ?? [])
    .filter((item) => item.status !== SecurityStatus.SKIPPED)
    .map((item) => item.category);
  if (categories.length !== new Set(requested).size || requested.some((item) => !categories.includes(item)))
    throw new CliError(
      'INVALID_ARGUMENT',
      '该项目已有其它范围的扫描在运行，本次未新建或取消扫描，请先查询现有记录',
      { reviewId: review.reviewId, checks: review.checks },
    );
}
