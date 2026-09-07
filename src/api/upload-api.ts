/** 文件上传凭据申请、内容上传和审核状态查询。@author xiuyu.yi */
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { CreationRuntime } from '../runtime.js';
import { list, object, text, requiredText } from '../contracts/value.js';
import type { JsonObject } from '../contracts/value.js';
import { pollOperation } from '../commands/shared.js';
import { CliError } from '../output/exit-codes.js';

const MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export type InputAttachment = { name: string; mediaType: string; content?: string; url?: string };
export async function uploadAttachment(service: CreationRuntime, path: string): Promise<InputAttachment> {
  const name = basename(path),
    extension = extname(name).slice(1).toLowerCase();
  const mediaType = MIME[extension];
  if (!mediaType) throw new CliError('INVALID_ARGUMENT', '不支持该附件扩展名');
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > 20 * 1024 * 1024)
    throw new CliError('INVALID_ARGUMENT', '附件必须为不超过 20MB 的普通文件');
  const bytes = await readFile(path);
  if (['txt', 'md', 'json', 'csv'].includes(extension) && bytes.length <= 256_000)
    return { name, mediaType, content: bytes.toString('utf8') };
  const tokenResponse = await service.client.request(
    `/api/uxa-center/support/FileUpload/getUploadToken?fileType=${encodeURIComponent(extension)}`,
    undefined,
    { method: 'GET' },
  );
  const token = object(tokenResponse.data),
    credential = requiredText(token.token, '上传凭据');
  service.output.registerSecret(credential);
  const encryptedId = requiredText(token.encryptedId, '上传记录');
  const form = new FormData();
  form.append('token', credential);
  form.append('file', new Blob([bytes], { type: mediaType }), name);
  let uploaded: Response;
  try {
    uploaded = await fetch('https://upload-na0.qiniup.com', {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: service.client.signal
        ? AbortSignal.any([service.client.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
  } catch {
    throw new CliError('OUTCOME_UNKNOWN', '附件上传结果不确定，尚未发送创作消息');
  }
  if (!uploaded.ok) throw new CliError('BUSINESS_ERROR', '附件上传失败，尚未发送创作消息');
  const file = await pollOperation(
    async () => {
      const result = object(
        await service.client.call('/api/uxa-center/support/FileUpload/queryFileUrl', {
          encryptedIds: [encryptedId],
        }),
      );
      const item = object(list(result.items)[0]);
      if (item.auditStatus === 1 || item.auditStatus === 4) return item;
      if (item.auditStatus === 0) return item;
      throw new CliError('BUSINESS_ERROR', '附件审核未通过');
    },
    (item) => item.auditStatus !== 0,
    { timeout: 180, signal: service.client.signal },
  );
  const url = text(file.url);
  if (!url) throw new CliError('PROTOCOL_ERROR', '附件审核完成但没有可用地址');
  return { name, mediaType, url };
}
