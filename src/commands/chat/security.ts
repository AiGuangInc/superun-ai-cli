/** 选择安全扫描即执行，后续评估、修复和报告均由 Center 自动推进。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime, businessWrite, withWait, waitOptions } from '../shared.js';
import { object, text } from '../../contracts/value.js';
import { SecurityStage, SecurityStatus } from '../../contracts/security-review.js';
import { securityActive } from '../../api/security-review-api.js';
import { CliError } from '../../output/exit-codes.js';
import { appendValue } from './message.js';

export function registerSecurity(chat: Command, context: CommandContext): void {
  withWait(chat.command('security <sessionId>').description('安全扫描，自动评估、必要修复并生成审计报告'))
    .option('--check <category>', '仅在用户指定范围时传入检查项，可重复使用；默认全部可用项', appendValue, [])
    .option('--retry-report <reviewId>', '只重试本次失败的审计报告，不重新扫描或修复')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const options = object(command.opts());
      const retryId = text(options.retryReport);
      const requested = options.check as string[];
      if (retryId && requested.length) throw new CliError('INVALID_ARGUMENT', '重试报告不能指定检查项');
      const current = await service.security.query(sessionId, retryId);
      let reviewId = current.reviewId;
      if (retryId) {
        if (
          !current.found ||
          current.stage !== SecurityStage.FAILED ||
          current.reportStatus !== SecurityStatus.FAILED
        )
          throw new CliError('INVALID_ARGUMENT', '本次报告不处于可重试状态，请查询扫描进度', {
            sessionId,
            reviewId: retryId,
          });
        await businessWrite(context, service, sessionId, () =>
          service.security.retryReport(sessionId, retryId),
        );
      } else if (!current.found || !securityActive(current)) {
        const catalog = (await service.security.options(sessionId)).filter(
          (item) => item.selectable !== false && item.available !== false,
        );
        if (!catalog.length)
          throw new CliError('INVALID_ARGUMENT', '当前项目暂无可执行的安全检查项，请先完成研发', {
            sessionId,
          });
        if (requested.some((category) => !catalog.some((item) => item.category === category)))
          throw new CliError('INVALID_ARGUMENT', '指定检查项不可用，请使用当前项目的实际检查项', {
            checks: catalog,
          });
        const checks = requested.length ? [...new Set(requested)] : catalog.map((item) => item.category);
        await businessWrite(context, service, sessionId, async () => {
          const response = await service.security.start(sessionId, checks);
          reviewId = response.reviewId;
          return response;
        });
      }
      if (!reviewId)
        throw new CliError('OUTCOME_UNKNOWN', '扫描回执缺少标识，请查询会话，勿重复启动', {
          sessionId,
          retryable: false,
        });
      context.output.write(
        options.wait === false
          ? await service.state(sessionId, reviewId)
          : await service.wait(sessionId, { ...waitOptions(command), reviewId }),
      );
    });
}
