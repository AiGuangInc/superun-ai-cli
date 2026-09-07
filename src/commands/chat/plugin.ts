/** 插件查询与生命周期操作。@author xiuyu.yi */
import type { Command } from 'commander';
import type { CommandContext } from '../shared.js';
import { runtime, readInput, withWait, waitOptions, pollOperation, businessWrite } from '../shared.js';
import { integrationKey } from '../../interactions/handlers/reply-plugin.js';
import { object, requiredText, text } from '../../contracts/value.js';
import { CliError } from '../../output/exit-codes.js';

const ACTIVE = new Set(['ENABLING', 'RESTORING', 'DISABLING', 'PAUSING']);
export function registerPlugin(chat: Command, context: CommandContext): void {
  const plugin = chat.command('plugin').description('查询、启用和禁用插件');
  plugin
    .command('list <sessionId>')
    .description('查询可用插件')
    .action(async (sessionId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      context.output.write({ state: 'COMPLETED', sessionId, ...(await service.plugin.list(sessionId)) });
    });
  plugin
    .command('status <sessionId> <pluginId>')
    .description('查询插件状态')
    .action(async (sessionId: string, pluginId: string, _options: unknown, command: Command) => {
      const service = await runtime(context, command);
      context.output.write({
        state: 'COMPLETED',
        sessionId,
        plugin: await service.plugin.operate('status', sessionId, pluginId),
      });
    });
  for (const action of ['enable', 'disable'] as const) {
    const command = withWait(
      plugin
        .command(`${action} <sessionId> <pluginId>`)
        .description(action === 'enable' ? '启用插件' : '禁用插件'),
    );
    if (action === 'enable') command.option('--input <file>', '插件配置 JSON 文件');
    command.action(async (sessionId: string, pluginId: string, _options: unknown, current: Command) => {
      const service = await runtime(context, current),
        options = object(current.opts());
      let result = await service.plugin.operate('status', sessionId, pluginId);
      const completed =
        action === 'enable'
          ? result.state === 'ENABLED'
          : ['NOT_ENABLED', 'DISABLED', 'PAUSED'].includes(String(result.state));
      if (!completed) {
        result = object(
          await businessWrite(context, service, sessionId, async () => {
            if (action === 'enable' && options.input) {
              const config = await readInput(requiredText(options.input, 'input'));
              for (const value of Object.values(config))
                if (typeof value === 'string') context.output.registerSecret(value);
              const response = await service.integration.connect(sessionId, integrationKey(pluginId), config);
              return { pluginId, state: response.integrationStatus };
            }
            return service.plugin.operate(action, sessionId, pluginId);
          }),
        );
      }
      let waitTimedOut = false;
      if (options.wait !== false && ACTIVE.has(String(result.state))) {
        try {
          result = await pollOperation(
            () => service.plugin.operate('status', sessionId, pluginId),
            (value) => !ACTIVE.has(String(value.state)),
            { ...waitOptions(current), signal: context.signal },
          );
        } catch (error) {
          if (!(error instanceof CliError) || error.code !== 'LOCAL_WAIT_TIMEOUT') throw error;
          waitTimedOut = true;
          result = await service.plugin.operate('status', sessionId, pluginId);
        }
      }
      const pending = ACTIVE.has(String(result.state));
      const success =
        action === 'enable'
          ? result.state === 'ENABLED'
          : ['NOT_ENABLED', 'DISABLED', 'PAUSED'].includes(String(result.state));
      if (!pending && !success)
        throw new CliError('BUSINESS_ERROR', '插件操作未达到目标状态', {
          sessionId,
          pluginId,
          state: text(result.state),
        });
      context.output.write({
        state: pending ? 'RUNNING' : 'COMPLETED',
        sessionId,
        plugin: result,
        ...(waitTimedOut ? { waitTimedOut } : {}),
      });
    });
  }
}
