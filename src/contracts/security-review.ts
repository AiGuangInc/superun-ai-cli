/** 安全扫描接口和 CLI 输出共用的数据契约。@author xiuyu.yi */
import { z } from 'zod';

const status = z.number().int().min(0).max(5);
const checkSchema = z.object({
  category: z.string().min(1),
  label: z.string().optional(),
  status,
  statusDesc: z.string().optional(),
});
export const securityReviewSchema = z.object({
  found: z.boolean(),
  reviewId: z.string().min(1).optional(),
  reviewSeqNo: z.number().optional(),
  stage: z.number().int().min(0).max(8).optional(),
  stageDesc: z.string().optional(),
  currentCheckCategory: z.string().nullish(),
  checks: z.array(checkSchema).optional(),
  assessmentStatus: status.nullish(),
  remediationRequired: z.boolean().nullish(),
  remediationStatus: status.nullish(),
  reportStatus: status.nullish(),
  reportStatusDesc: z.string().optional(),
  reportResult: z.string().nullish(),
  reportPdfUrl: z.string().nullish(),
  reportGeneratedAt: z.union([z.number(), z.string()]).nullish(),
  invalidatedReason: z.string().nullish(),
});
export type SecurityReviewView = z.infer<typeof securityReviewSchema>;
export type SecurityReviewResult = Omit<SecurityReviewView, 'found'> & { reviewId: string };

export const SecurityStage = {
  CREATED: 0,
  CHECKING: 1,
  ASSESSING: 2,
  REMEDIATING: 3,
  REPORTING: 4,
  COMPLETED: 5,
  FAILED: 6,
  CANCELLED: 7,
  INVALIDATED: 8,
} as const;
export const SecurityStatus = {
  SKIPPED: 0,
  PENDING: 1,
  RUNNING: 2,
  SUCCEEDED: 3,
  FAILED: 4,
  CANCELLED: 5,
} as const;
