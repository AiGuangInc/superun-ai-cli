/** 网站搬家：输入网址新建复刻项目，提交后在后台运行，不修改通用 creation 流程。 */
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import type { CommandContext } from './shared.js';
import { businessWrite, runtime } from './shared.js';
import { object, text } from '../contracts/value.js';
import { CliError } from '../output/exit-codes.js';
import { requestChannel } from '../config/request-channel.js';

const CLONE_NOTICE = '网站搬家已经开始，在后台运行：先读网站，读完自动生成第一版页面，整个过程比较久。';
const CLONE_INSTRUCTION =
  '告诉用户搬家已经在后台运行、需要一段时间，给项目页链接让用户随时去看；不要等待或轮询，用户之后问起进度再查询。';

/** 与 Glow 搬家页的网址校验一致：省略协议时按 https://，此时域名必须带点；不接受其他协议和账号密码。 */
export function siteUrl(value: string): string {
  const input = value.trim();
  const prefix = input.match(/^https?:\/\//i)?.[0];
  const address = (prefix ? input.slice(prefix.length) : input).trim();
  const authority = address.split(/[/?#]/, 1)[0] ?? '';
  const message = `${prefix?.toLowerCase() ?? 'https://'}${address}`;
  if (
    address &&
    !/^(?:https?:|[a-z][a-z\d+.-]*:\/\/)/i.test(address) &&
    (prefix || authority.includes('.') || authority.startsWith('[')) &&
    /^https?:\/\/[^/\s\\][^\s\\]*$/i.test(message)
  ) {
    try {
      const url = new URL(message);
      if (url.hostname && !url.username && !url.password) return message;
    } catch {
      // 落到下面统一报错。
    }
  }
  throw new InvalidArgumentError('请传入要搬家的网站地址，例如 https://example.com');
}

export function registerClone(program: Command, context: CommandContext): void {
  const clone = program
    .command('clone')
    .description('网站搬家：把已有网站的页面样式和内容复刻成 superun 项目');
  clone
    .command('create')
    .argument('<url>', '要搬家的网站地址，省略协议时按 https://', siteUrl)
    .description(
      '输入网址新建搬家项目，提交后在后台运行，不用等待；每周有免费次数（free-quota 的 site_clone_weekly），用完后按积分收费',
    )
    .option('--workspace-id <workspaceId>', '归属工作空间')
    .action(async (url: string, _options: unknown, command: Command) => {
      const { workspaceId } = command.opts<{ workspaceId?: string }>();
      const service = await runtime(context, command);
      const config = await service.config.creation(url);
      const response = object(
        await businessWrite(context, service, undefined, () =>
          service.command.chat({
            content: url,
            workspaceId,
            // 和 Glow 搬家页一样从探索阶段读站开始；服务端读完自动交接并生成第一版。
            sessionExtra: {
              agentRuntime: 'shire',
              siteClone: '1',
              hasSlidesIntent: '0',
              generatedByBranch: '1',
              version: '6',
              source: requestChannel,
            },
            roundExtra: { ROUND_LANGUAGE: config.language },
          }),
        ),
      );
      // 搬家耗时长，提交后不跟：告诉用户已在后台运行，给项目页链接。
      const sessionId = text(response.sessionId);
      if (!sessionId)
        throw new CliError('OUTCOME_UNKNOWN', '搬家请求已返回，但缺少项目 ID；请先查询项目列表，勿重复创建', {
          retryable: false,
        });
      const projectUrl = new URL(
        `/web/project/${encodeURIComponent(sessionId)}`,
        service.client.config.endpoint,
      ).href;
      context.output.write({
        state: 'ACCEPTED',
        sessionId,
        messageId: text(response.messageId),
        replyMessageId: text(response.replyMessageId),
        cloneNotice: CLONE_NOTICE,
        nextActions: [
          {
            action: 'VIEW_PROJECT',
            requiresUserInput: false,
            url: projectUrl,
            instruction: CLONE_INSTRUCTION,
          },
        ],
      });
    });
}
