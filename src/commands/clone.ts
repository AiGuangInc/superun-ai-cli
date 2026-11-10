/** 网站搬家：输入网址新建复刻项目，不修改通用 creation 流程。 */
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import type { CommandContext } from './shared.js';
import { businessWrite, runtime } from './shared.js';
import { object } from '../contracts/value.js';
import { requestChannel } from '../config/request-channel.js';

const CLONE_NOTICE =
  '已开始搬家：先读取网站，读完后自动生成第一版页面，期间如有问题会停下来问用户；之后可以选这一版继续编辑，或委托高级设计师重新设计。';

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
      '输入网址新建搬家项目，后续沿回执查询进度；每周有免费次数（free-quota 的 site_clone_weekly），用完后按积分收费',
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
      context.output.write({
        ...(await service.accepted(response, undefined, false, {})),
        cloneNotice: CLONE_NOTICE,
      });
    });
}
