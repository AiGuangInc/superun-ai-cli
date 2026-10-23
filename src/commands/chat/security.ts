/** 安全扫描使用独立记录，查询与新启动分路。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime, businessWrite, withWait, waitOptions } from '../shared.js';
import { object, text } from '../../contracts/value.js';
import { SecurityStage, SecurityStatus } from '../../contracts/security-review.js';
import { securityActive } from '../../api/security-review-api.js';
import { CliError } from '../../output/exit-codes.js';
import { appendValue } from './message.js';
import {
  selectSecurityChecks,
  securityStartPreflight,
  assertExistingSecurityScope,
} from '../../conversation/security-entry.js';

export function registerSecurity(chat: Command, context: CommandContext): void {
  withWait(chat.command('security <sessionId>').description('安全扫描，自动评估、必要修复并生成审计报告'))
    .option('--check <category>', '用户指定的检查项，可重复；默认全部明确可用项', appendValue, [])
    .option('--list-checks', '只列本项目实时检查目录，不启动扫描')
    .option('--status', '只查当前或指定扫描的快照，不启动或重试')
    .option('--review-id <reviewId>', '仅随--status查询指定扫描')
    .option('--retry-report <reviewId>', '只重试本次失败的审计报告，不重新扫描或修复')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const options = object(command.opts()),
        requested = options.check as string[];
      const retryId = text(options.retryReport),
        queryId = text(options.reviewId);
      if (
        !/^[A-Za-z0-9_-]+$/.test(sessionId) ||
        [retryId, queryId].some((id) => id !== undefined && !/^[A-Za-z0-9_-]+$/.test(id))
      )
        throw new CliError('INVALID_ARGUMENT', '请明确一个作品及有效的本次扫描ID');
      if (
        (options.listChecks && (options.status || retryId || queryId || requested.length)) ||
        (options.status && (retryId || requested.length)) ||
        (queryId && !options.status) ||
        (retryId && requested.length)
      )
        throw new CliError(
          'INVALID_ARGUMENT',
          '检查目录、查询状态、指定检查与报告重试不能混用；review-id仅随status使用',
        );
      const service = await runtime(context, command),
        view = await service.load(sessionId);
      if (view.session.sessionId !== sessionId)
        throw new CliError('PROTOCOL_ERROR', '安全扫描目标返回了不同作品');
      if (options.listChecks) {
        const checks = await service.security.options(sessionId);
        const unknown =
          checks.some(
            (item) => typeof item.available !== 'boolean' || typeof item.selectable !== 'boolean',
          ) || new Set(checks.map((item) => item.category)).size !== checks.length;
        context.output.write({
          state: 'COMPLETED',
          sessionId,
          topic: view.session.topic,
          catalogState: unknown
            ? 'UNKNOWN'
            : checks.some((item) => item.available === true && item.selectable === true)
              ? 'AVAILABLE'
              : 'UNAVAILABLE',
          checks,
        });
        return;
      }
      const current = await service.security.query(sessionId, options.status ? queryId : retryId);
      if (options.status) {
        context.output.write(
          current.found && current.reviewId
            ? await service.state(sessionId, current.reviewId)
            : { state: 'NO_REVIEW', sessionId, requestedReviewId: queryId, found: false },
        );
        return;
      }
      let reviewId = current.reviewId,
        operation = 'REUSED';
      if (retryId) {
        const retryable = (row: typeof current) =>
          row.found &&
          row.reviewId === retryId &&
          row.stage === SecurityStage.FAILED &&
          row.reportStatus === SecurityStatus.FAILED;
        if (!retryable(current))
          throw new CliError('INVALID_ARGUMENT', '该报告不处于可重试状态，请查询本次记录', {
            sessionId,
            reviewId: retryId,
          });
        await businessWrite(context, service, sessionId, async () => {
          if (!retryable(await service.security.query(sessionId, retryId)))
            throw new CliError('STALE_INTERACTION', '该报告状态已变化，未重试');
          await service.security.retryReport(sessionId, retryId);
        });
        operation = 'RETRY_REPORT';
      } else if (current.found && securityActive(current)) {
        assertExistingSecurityScope(current, requested);
      } else {
        const gate = await securityStartPreflight(service, sessionId, undefined, view);
        const checks = selectSecurityChecks(await service.security.options(sessionId), requested);
        await businessWrite(context, service, sessionId, async () => {
          await securityStartPreflight(service, sessionId, gate.sourceMessageId);
          const latest = await service.security.query(sessionId);
          if (latest.found && securityActive(latest)) {
            assertExistingSecurityScope(latest, requested);
            reviewId = latest.reviewId;
            return;
          }
          selectSecurityChecks(await service.security.options(sessionId), checks);
          const response = await service.security.start(sessionId, checks);
          reviewId = response.reviewId;
          operation = 'STARTED';
        });
      }
      if (!reviewId)
        throw new CliError('OUTCOME_UNKNOWN', '扫描回执缺少标识，请查询本作品已有记录，勿重复启动', {
          sessionId,
          retryable: false,
        });
      const result =
        options.wait === false
          ? await service.state(sessionId, reviewId)
          : await service.wait(sessionId, { ...waitOptions(command), reviewId });
      context.output.write({ ...result, securityOperation: operation, requestedChecks: requested });
    });
}
