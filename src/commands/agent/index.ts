/** 只搭建托管智能体配置，复用官方入口和既有向导。@author xiuyu.yi */
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import { z } from 'zod';
import type { CommandContext } from '../shared.js';
import { runtime, readInput, businessWrite } from '../shared.js';
import { object } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';
import { startAgentCreation } from '../../conversation/managed-agent-create-only.js';
import { ManagedAgentResourceApi, validateManagedAgentId } from '../../api/managed-agent-resource-api.js';

function sessionValue(value: string): string {
  if (!value || /[\s,\/\\?#]/.test(value))
    throw new InvalidArgumentError('请明确一个主项目sessionId，不能传分支链接或多个目标');
  return value;
}

export function registerAgent(program: Command, context: CommandContext): void {
  const agent = program.command('agent').description('搭建托管智能体配置并读回资源，不运行或部署');
  agent
    .command('create')
    .argument('<sessionId>', '本次明确的主项目资源域', sessionValue)
    .description('提交官方智能体创建入口，只创建资源；后续用chat state查看向导')
    .option('--message <text>', '本次智能体工作说明，最多4000字符')
    .option('--input <file>', '仅含content或message的JSON，-表示标准输入')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const options = command.opts<{ message?: string; input?: string }>();
      if ((options.message !== undefined) === (options.input !== undefined))
        throw new CliError('INVALID_ARGUMENT', '--message和--input必须且只能选一个');
      const input = z
        .object({ content: z.string().optional(), message: z.string().optional() })
        .strict()
        .safeParse(
          options.input !== undefined ? await readInput(options.input) : { message: options.message },
        );
      if (!input.success || (input.data.content !== undefined && input.data.message !== undefined))
        throw new CliError('INVALID_ARGUMENT', '工作说明JSON只能包含content或message之一');
      const description = (input.data.content ?? input.data.message ?? '').trim();
      if (!description || description.length > 4000)
        throw new CliError('INVALID_ARGUMENT', '智能体工作说明须为1至4000字符');
      const service = await runtime(context, command);
      const response = object(
        await businessWrite(context, service, sessionId, () =>
          startAgentCreation(service, sessionId, description),
        ),
      );
      const result = await service.accepted(response, sessionId, false, {});
      context.output.write({
        ...result,
        managedAgentEntry: {
          createOnly: true,
          sessionId,
          sourceMessageId: response.sourceMessageId ?? response.messageId ?? null,
          reused: response.reused === true,
          phase: response.entryPending ? 'ENTRY_PENDING' : 'SUBMITTED',
        },
      });
    });
  agent
    .command('get')
    .argument('<sessionId>', '资源所属的同一主项目', sessionValue)
    .argument('<agentId>', '平台返回的公开uxagent_智能体ID', validateManagedAgentId)
    .description('在指定项目资源域只读核验已创建智能体，不创建测试运行会话')
    .action(async (sessionId: string, agentId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      const resource = await new ManagedAgentResourceApi(service.client).getAgent(sessionId, agentId);
      context.output.write({
        state: 'COMPLETED',
        resourceSessionId: sessionId,
        agentId,
        verified: true,
        agent: resource,
      });
    });
}
