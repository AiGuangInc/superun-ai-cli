/** 查询当前用户及指定项目的免费额度。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from './shared.js';
import { runtime } from './shared.js';
import { CliError } from '../output/exit-codes.js';

const QUOTA_NAMES: Record<string, string> = {
  'free_round:stage2_designer': '高级设计师方案优化',
  'free_round:issue_review': '代码审查',
  'free_round:auto_test': '自动测试',
};

export function registerFreeQuota(program: Command, context: CommandContext): void {
  program
    .command('free-quota [sessionId]')
    .description('查询当前用户及指定项目的免费额度')
    .action(async (sessionId: string | undefined, _options, command: Command) => {
      if (sessionId !== undefined && !sessionId.trim())
        throw new CliError('INVALID_ARGUMENT', 'sessionId 不能为空或仅包含空白字符');
      const service = await runtime(context, command);
      const items = await service.query.userFreeQuota(sessionId);
      context.output.write({
        ...(sessionId ? { sessionId } : {}),
        queryScope: sessionId ? 'user_and_session' : 'user',
        items: items.map((item) => {
          const expectedFree = item.remaining > 0;
          return {
            ...item,
            quotaName: QUOTA_NAMES[item.quotaKey] ?? `额度 ${item.quotaKey}`,
            expectedCharge: expectedFree ? 'free' : 'paid',
            expectedFree,
          };
        }),
        uncertainty:
          '各项费用状态按查询时的额度预估，额度可能在查询后变化；提交任务后以服务端 tokenFree 回执确认高级设计师委托的实际状态。',
      });
    });
}
