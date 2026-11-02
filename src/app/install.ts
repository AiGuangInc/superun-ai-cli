/** 用本次真实安装页生成二维码，不调用外部二维码服务。@author xiuyu.yi */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as QRCode from 'qrcode';
import { z } from 'zod';
import { AppService } from './service.js';
import { CliError } from '../output/exit-codes.js';
import { stateDirectory } from '../config/state-directory.js';
import { fingerprint } from '../interactions/draft-store.js';
import { object, text } from '../contracts/value.js';
import type { AppResult } from './contracts.js';

function artifactUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError('PROTOCOL_ERROR', '包文件地址不是有效 URL');
  }
  if (
    url.protocol !== 'https:' ||
    !['b.yzcdn.cn', 'b.ux-cdn.com'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw new CliError('PROTOCOL_ERROR', '包文件地址不属于当前平台支持的托管域名');
  return url;
}
async function manifestText(raw: string) {
  const url = artifactUrl(raw);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok || Number(response.headers.get('content-length')) > 128 * 1024)
    throw new CliError('PROTOCOL_ERROR', '安装清单暂时无法读取');
  const body = await response.text();
  if (body.length > 128 * 1024) throw new CliError('PROTOCOL_ERROR', '安装清单超出大小限制');
  return body;
}
function xmlText(value: string) {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos);/g,
    (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]!,
  );
}
function plistString(value: string, key: string) {
  const found = value.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`));
  return found?.[1] === undefined ? undefined : xmlText(found[1]);
}
export async function installApp(service: AppService, taskId: string, output?: string): Promise<AppResult> {
  const records = await service.api.builds(service.sessionId, service.platform);
  const record = records.find((item) => item.taskId === taskId);
  if (!record || record.buildStatus !== 1 || !record.downloadUrl)
    throw new CliError('INVALID_ARGUMENT', '当前项目与平台的授权列表没有该成功包，不能生成安装二维码');
  if (record.buildType === 'release' && service.platform !== 'android')
    return {
      state: 'COMPLETED',
      stage: 'STORE_DELIVERY',
      sessionId: service.sessionId,
      platform: service.platform,
      record,
      nextActions: [],
      notice: '这是应用商店包，请查看实际上传状态并在对应平台配置测试分发。上传成功不等于已有邀请安装链接。',
    };
  const context = await service.context();
  if (
    context.taskId === taskId &&
    context.publishedSnapshotId &&
    record.sourceSnapshotId !== context.publishedSnapshotId
  )
    throw new CliError('STALE_INTERACTION', '本次包源码与确认的上线快照不一致，不作为本次成果交付');
  const info = await service.api.install(taskId);
  if (
    !info ||
    info.platform !== service.platform ||
    info.versionName !== record.versionName ||
    info.versionCode !== record.versionCode ||
    (info.buildType && info.buildType !== record.buildType)
  )
    throw new CliError('PROTOCOL_ERROR', '安装信息与本次成功包不一致');
  let delivery = new URL(`/web/app-install/${taskId}`, service.runtime.client.config.endpoint).href;
  let page = await fetch(delivery, { signal: AbortSignal.timeout(30_000), redirect: 'manual' });
  // 正式站会将裸域跳到 www，只接受当前站点的规范域和同一个安装路径。
  if ([301, 302, 307, 308].includes(page.status) && page.headers.get('location')) {
    const canonical = new URL(page.headers.get('location')!, delivery);
    const original = new URL(delivery);
    if (
      canonical.protocol !== original.protocol ||
      canonical.hostname.replace(/^www\./, '') !== original.hostname.replace(/^www\./, '') ||
      canonical.pathname !== original.pathname ||
      canonical.search ||
      canonical.hash ||
      canonical.username ||
      canonical.password ||
      canonical.port
    )
      throw new CliError('PROTOCOL_ERROR', '安装页跳转不属于当前站点和包');
    delivery = canonical.href;
    page = await fetch(delivery, { signal: AbortSignal.timeout(30_000), redirect: 'manual' });
  }
  if (!page.ok)
    throw new CliError('PROTOCOL_ERROR', '包已生成，但当前安装页暂时不可访问', {
      taskId,
      installUrl: delivery,
    });
  let packageUrl = artifactUrl(info.downloadUrl).href;
  let artifactError: string | undefined;
  try {
    if (service.platform === 'harmony') {
      const manifest = artifactUrl(info.downloadUrl);
      manifest.searchParams.delete('attname');
      if (manifest.search || !manifest.pathname.endsWith('.json5'))
        throw new Error('鸿蒙产物不是支持的安装清单');
      const value = JSON.parse(await manifestText(manifest.href));
      const app = object(object(value).app);
      const modules = z
        .array(z.object({ packageUrl: z.string(), packageHash: z.string().regex(/^[a-f0-9]{64}$/i) }))
        .length(1)
        .parse(app.modules);
      if (
        !text(object(value).sign) ||
        app.bundleName !== record.appId ||
        app.versionName !== record.versionName ||
        app.versionCode !== record.versionCode
      )
        throw new Error('鸿蒙清单与本次包信息不一致');
      const url = artifactUrl(modules[0]!.packageUrl);
      if (url.hostname !== app.deployDomain || url.search || !/\.(hap|hsp)$/.test(url.pathname))
        throw new Error('鸿蒙包文件地址不符合安装清单');
      packageUrl = url.href;
    } else if (service.platform === 'ios') {
      // 标准 plist 声明不加载 DTD；自定义声明及实体仍拒绝，避免扩展外部内容。
      const value = (await manifestText(info.downloadUrl)).replace(
        /<!DOCTYPE\s+plist\s+PUBLIC\s+(["'])-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN\1\s+(["'])https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd\2\s*>/i,
        '',
      );
      if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('不支持含外部实体的安装清单');
      // 平台清单的资源条目为扁平 dict，只读取明确标记的 IPA，不猜第一个 url。
      const entries = [...value.matchAll(/<dict>((?:(?!<\/?dict>)[\s\S])*)<\/dict>/g)].map(
        (item) => item[1]!,
      );
      const asset = entries.find((item) => plistString(item, 'kind') === 'software-package');
      const version = plistString(value, 'bundle-version');
      if (
        !asset ||
        plistString(value, 'bundle-identifier') !== record.appId ||
        (version !== record.versionName && version !== String(record.versionCode))
      )
        throw new Error('苹果清单与本次包信息不一致');
      packageUrl = artifactUrl(plistString(asset, 'url') ?? '').href;
    }
  } catch (error) {
    packageUrl = '';
    artifactError = error instanceof Error ? error.message : '无法读取本次清单中的包文件';
  }
  let qrPath: string | undefined, qrError: string | undefined;
  try {
    const file = output
      ? resolve(output)
      : join(
          stateDirectory(),
          'app-deliveries',
          service.runtime.client.interactionScope,
          fingerprint(service.sessionId).slice(0, 24),
          `${taskId}.png`,
        );
    if (!file.toLowerCase().endsWith('.png')) throw new Error('二维码输出文件须为 PNG');
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const bytes = await QRCode.toBuffer(delivery, {
      type: 'png',
      width: 640,
      margin: 4,
      errorCorrectionLevel: 'M',
    });
    try {
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (object(error).code !== 'EEXIST' || !(await readFile(file)).equals(bytes)) throw error;
    }
    qrPath = file;
  } catch (error) {
    qrError = error instanceof Error ? error.message : '二维码图片生成失败';
  }
  const base = [
    'superun-ai',
    '--endpoint',
    service.runtime.client.config.endpoint,
    '--locale',
    service.runtime.client.config.locale,
    'app',
  ];
  return {
    state: 'COMPLETED',
    stage: 'DELIVERED',
    sessionId: service.sessionId,
    platform: service.platform,
    record,
    installUrl: delivery,
    qr: { path: qrPath, encodedUrl: delivery, error: qrError },
    artifact: {
      name: record.artifactName,
      packageUrl: packageUrl || undefined,
      manifestUrl: service.platform === 'android' ? undefined : info.downloadUrl,
      error: artifactError,
    },
    files: qrPath ? [{ path: qrPath, mimeType: 'image/png', purpose: '本次手机体验包安装二维码' }] : [],
    notice:
      '先在当前专家对话展示本次二维码、安装链接和版本，再提问下一步。鸿蒙/iOS 仅本次所选测试手机可安装；包生成不等于手机安装已验证。',
    question: {
      header: '下一步',
      question: '手机体验包已生成，接下来想做什么？',
      multiSelect: false,
      options: [
        {
          label: '查看历史包',
          description: '查看当前项目、本专家平台的最近打包记录。',
          action: 'APP_HISTORY',
        },
        {
          label: '查看备案信息',
          description: '查看当前实际可用的备案资料和来源正式版本。',
          action: 'APP_FILING',
        },
        { label: '继续开发', description: '直接告诉我想新增或调整的内容。', action: 'APP_CONTINUE' },
      ],
    },
    nextActions: [
      {
        action: 'APP_HISTORY',
        instruction: '只读查询本平台历史，展示实际返回范围。',
        requiresUserInput: true,
        command: [...base, 'history', 'list', service.sessionId, '--platform', service.platform],
      },
      {
        action: 'APP_FILING',
        instruction: '显示真实资料及其版本，没有正式包时如实说明未就绪。',
        requiresUserInput: true,
        command: [...base, 'filing', 'get', service.sessionId, '--platform', service.platform],
      },
      {
        action: 'APP_CONTINUE',
        instruction: '收取具体需求后继续原项目，不重新创建项目；本轮研发完成后再进行必要适配。',
        requiresUserInput: true,
        command: ['superun-ai', 'chat', 'send', service.sessionId, '--input', '<需求JSON文件>'],
      },
    ],
  };
}
