/** 与 Glow 同源的上传白名单、数量、大小和媒体预检。@author xiuyu.yi */
import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { CreationRuntime } from '../runtime.js';
import { CliError } from '../output/exit-codes.js';

export const MB = 1024 * 1024;
export const MAX_PIXELS = 24_999_999;
const ruleSchema = z.object({
  fileType: z.enum(['image', 'text', 'raw']),
  ext: z.string().min(1),
  size: z.number().finite().positive(),
  maxSize: z.number().finite().positive().optional(),
  maxPixels: z.number().finite().positive().optional(),
  visualCount: z.coerce.number().finite().positive().optional(),
  textLimit: z.number().finite().positive().optional(),
});
export type UploadRule = z.infer<typeof ruleSchema>;
export type PreparedFile = {
  name: string;
  extension: string;
  mediaType: string;
  rule: UploadRule;
  blob: Blob;
  image?: { width: number; height: number };
};

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  js: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  scss: 'text/plain',
  less: 'text/plain',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
};
for (const ext of ['py', 'java', 'cpp', 'c', 'h', 'cs', 'php', 'rb', 'go', 'rs', 'swift'])
  MIME[ext] = 'text/plain';

function readMedia(
  path: string,
  image: boolean,
  signal?: AbortSignal,
): Promise<{
  width?: number;
  height?: number;
  duration?: number;
  hasVideo: boolean;
}> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./upload-media-worker.js', import.meta.url), {
      workerData: { path, image },
      execArgv: [],
    });
    let finished = false;
    const finish = (error?: CliError, result?: Parameters<typeof resolve>[0]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(new CliError('INTERRUPTED', '已取消附件预检，尚未发送创作消息'));
    const timer = setTimeout(
      () => finish(new CliError('INVALID_ARGUMENT', `${basename(path)}：无法在 30 秒内读取媒体信息`)),
      30_000,
    );
    worker.once('message', (result) => finish(undefined, result));
    worker.once('error', () =>
      finish(new CliError('INVALID_ARGUMENT', `${basename(path)}：无法读取媒体信息，请检查文件是否损坏`)),
    );
    worker.once('exit', () => {
      if (!finished) finish(new CliError('INVALID_ARGUMENT', `${basename(path)}：媒体预检未返回结果`));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** 整批完成本地校验后才申请上传凭据，避免静默丢弃附件或发送不完整需求。 */
export async function prepareUploadFiles(service: CreationRuntime, paths: string[]): Promise<PreparedFile[]> {
  if (!paths.length) return [];
  if (paths.length > 10) throw new CliError('INVALID_ARGUMENT', '每条消息最多上传 10 个文件');
  if (paths.filter((path) => extname(path).toLowerCase() === '.pdf').length > 5)
    throw new CliError('INVALID_ARGUMENT', '每条消息最多上传 5 个 PDF');
  const response = await service.client.request('/web-api/config/file-ext-config', undefined, {
    method: 'GET',
  });
  const config = z.object({ fileExts: z.record(ruleSchema) }).safeParse(response.data);
  if (!config.success || !Object.keys(config.data.fileExts).length)
    throw new CliError('PROTOCOL_ERROR', '未取得有效的附件格式限制，尚未上传文件');
  const prepared: PreparedFile[] = [];
  for (const path of paths) {
    if (service.client.signal?.aborted) throw new CliError('INTERRUPTED', '已取消附件预检');
    const name = basename(path),
      extension = extname(name).slice(1).toLowerCase();
    const rule = config.data.fileExts[extension],
      mediaType = MIME[extension];
    if (!rule || !mediaType || rule.ext.toLowerCase() !== extension)
      throw new CliError('INVALID_ARGUMENT', `${name}：不支持此文件格式`, {
        supportedExtensions: Object.keys(config.data.fileExts).filter((ext) => MIME[ext]),
      });
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size === 0)
      throw new CliError('INVALID_ARGUMENT', `${name}：附件必须是可读取的非空普通文件`);
    // 图片允许先按 Glow 的流程压缩，其余格式在上传前检查原文件大小。
    if (rule.fileType !== 'image' && info.size > rule.size * MB)
      throw new CliError('INVALID_ARGUMENT', `${name}：文件不能超过 ${rule.size}MB`);
    const item: PreparedFile = {
      name,
      extension,
      mediaType,
      rule,
      blob: await openAsBlob(path, { type: mediaType }),
    };
    if (rule.fileType === 'image' || mediaType.startsWith('video/')) {
      const media = await readMedia(path, rule.fileType === 'image', service.client.signal);
      if (rule.fileType === 'image') {
        const { width, height } = media;
        if (!width || !height || !Number.isFinite(width * height))
          throw new CliError('INVALID_ARGUMENT', `${name}：无法读取图片尺寸`);
        if (rule.maxSize && Math.max(width, height) > rule.maxSize)
          throw new CliError('INVALID_ARGUMENT', `${name}：图片宽高不能超过 ${rule.maxSize} 像素`);
        item.image = { width, height };
      } else if (
        !media.hasVideo ||
        !media.duration ||
        !Number.isFinite(media.duration) ||
        media.duration <= 0 ||
        media.duration > 302
      ) {
        throw new CliError('INVALID_ARGUMENT', `${name}：视频必须能读取时长且不超过 5 分钟（含 2 秒容差）`);
      }
    }
    prepared.push(item);
  }
  return prepared;
}
