/** Glow 同源的安全扫描接口；编排和自动修复由 Center 负责。@author xiuyu.yi */
import { z } from 'zod';
import type { ApiClient } from '../transport/api-client.js';
import { parseWire } from '../contracts/node-wire.js';
import { CliError } from '../output/exit-codes.js';
import { securityReviewSchema, SecurityStage } from '../contracts/security-review.js';
import type { SecurityReviewView, SecurityReviewResult } from '../contracts/security-review.js';

const PREFIX = '/api/uxa-center/agent/AgentSecurityReview';
export function securityActive(review: SecurityReviewView | SecurityReviewResult): boolean {
  return review.stage !== undefined && review.stage < SecurityStage.COMPLETED;
}

export class SecurityReviewApi {
  private startReceipt?: { sessionId: string; review: SecurityReviewView };
  constructor(private readonly client: ApiClient) {}

  async options(sessionId: string) {
    return parseWire(
      z.object({
        checks: z.array(
          z.object({
            category: z.string().min(1),
            label: z.string(),
            description: z.string().optional(),
            seq: z.number().optional(),
            selectable: z.boolean().optional(),
            available: z.boolean().optional(),
          }),
        ),
      }),
      await this.client.call(`${PREFIX}/listSecurityCheckOptions`, { sessionId }),
    ).checks;
  }

  async start(sessionId: string, checks: string[]): Promise<SecurityReviewView> {
    const response = await this.client.call(
      `${PREFIX}/startSecurityReview`,
      {
        sessionId,
        checks,
        locale: this.client.config.locale,
      },
      true,
    );
    try {
      const started = parseWire(
        securityReviewSchema.omit({ found: true }).extend({ reviewId: z.string().min(1) }),
        response,
      );
      const review = { ...started, found: true, stage: started.stage ?? SecurityStage.CREATED };
      this.startReceipt = { sessionId, review };
      return review;
    } catch {
      throw new CliError('OUTCOME_UNKNOWN', '扫描已提交但回执不完整，请查询当前扫描，勿重复启动', {
        sessionId,
        retryable: false,
      });
    }
  }

  async query(sessionId: string, reviewId?: string, includeResults = false): Promise<SecurityReviewView> {
    const review = parseWire(
      securityReviewSchema,
      await this.client.call(`${PREFIX}/querySecurityReview`, {
        sessionId,
        ...(reviewId ? { reviewId } : {}),
        includeResults,
      }),
    );
    // 新建记录尚未同步到查询副本时保留已接受回执，继续等待同一个 ID，绝不重发启动。
    if (
      !review.found &&
      this.startReceipt?.sessionId === sessionId &&
      this.startReceipt.review.reviewId === reviewId
    )
      return this.startReceipt.review;
    if (
      review.found &&
      (!review.reviewId || review.stage === undefined || (reviewId && review.reviewId !== reviewId))
    )
      throw new CliError('PROTOCOL_ERROR', '扫描状态缺少身份、阶段或与本次扫描不一致', {
        sessionId,
        reviewId,
      });
    if (review.found && this.startReceipt?.review.reviewId === reviewId) this.startReceipt = undefined;
    return review;
  }

  async cancel(sessionId: string, reviewId: string): Promise<void> {
    await this.client.call(`${PREFIX}/cancelSecurityReview`, { sessionId, reviewId }, true);
  }

  async retryReport(sessionId: string, reviewId: string): Promise<void> {
    await this.client.call(`${PREFIX}/retrySecurityAuditReport`, { sessionId, reviewId }, true);
  }
}
