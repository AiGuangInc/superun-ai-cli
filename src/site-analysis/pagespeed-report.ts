/** 只读取当前作品已有的官方性能报告，不携带登录凭据。@author xiuyu.yi */
import { object } from '../contracts/value.js';

export const REPORT_CATEGORIES = [
  { category: 'ACCESSIBILITY', key: 'accessibility', field: 'accessibility', label: '可访问性', bit: 1 },
  { category: 'BEST_PRACTICES', key: 'best-practices', field: 'bestPractices', label: '最佳实践', bit: 2 },
  { category: 'PERFORMANCE', key: 'performance', field: 'performance', label: '性能', bit: 4 },
  { category: 'SEO', key: 'seo', field: 'seo', label: 'SEO', bit: 8 },
] as const;
type Category = (typeof REPORT_CATEGORIES)[number];
type Audit = {
  id: string;
  title: string;
  score: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  numericValue?: number;
};
export type PageSpeedReport = {
  category: Category['category'];
  label: string;
  availability: 'AVAILABLE' | 'UNKNOWN' | 'NO_REPORT';
  score: number | null;
  audits: Audit[];
  reason?: string;
  reportUrl?: string;
  fetchTime?: string;
  requestedUrl?: string;
  finalUrl?: string;
};

const REPORT_HOSTS = new Set(['b.yzcdn.cn', 'b.ux-cdn.com']);
const MAX_REPORT_BYTES = 10 * 1024 * 1024;

function trustedReportUrl(raw: string, sessionId: string, category: Category): URL | undefined {
  try {
    if (raw.includes('\\') || /(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f)/i.test(raw)) return undefined;
    const url = new URL(raw);
    const prefix = `/superun/session/page_speed/${encodeURIComponent(sessionId)}_${category.category}_`;
    const path = url.pathname.replace(/^\/+/, '/');
    if (
      url.protocol !== 'https:' ||
      !REPORT_HOSTS.has(url.hostname) ||
      (url.port && url.port !== '443') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !path.startsWith(prefix) ||
      !/^[1-9]\d*\.json$/.test(path.slice(prefix.length))
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function publicHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    // 历史检测目标只作展示，不输出可能含凭据的查询参数，也不继续访问该地址。
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > MAX_REPORT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('报告超过大小限制');
  }
  if (!response.body) throw new Error('报告没有正文');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPORT_BYTES) throw new Error('报告超过大小限制');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function readPageSpeedReport(
  sessionId: string,
  category: Category,
  reportUrl: string | null | undefined,
  statusMask: number,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<PageSpeedReport> {
  const base: PageSpeedReport = {
    category: category.category,
    label: category.label,
    availability: 'UNKNOWN',
    score: null,
    audits: [],
  };
  if (!reportUrl) return { ...base, availability: 'NO_REPORT', reason: '未返回该分类的已有报告' };
  if ((statusMask & category.bit) === 0)
    return { ...base, reason: '该分类的已有报告尚未完整，无法判断是否仍在生成' };
  const url = trustedReportUrl(reportUrl, sessionId, category);
  if (!url) return { ...base, reason: '报告地址未通过存储域、作品及分类归属校验' };
  try {
    const timeout = AbortSignal.timeout(30_000);
    const response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('报告读取失败');
    }
    const root = object(await readBoundedJson(response));
    const lighthouse = object(root.lighthouseResult);
    const categoryResult = object(object(lighthouse.categories)[category.key]);
    const metadata = {
      reportUrl: url.toString(),
      ...(typeof lighthouse.fetchTime === 'string' ? { fetchTime: lighthouse.fetchTime } : {}),
      ...(publicHttpUrl(lighthouse.requestedUrl)
        ? { requestedUrl: publicHttpUrl(lighthouse.requestedUrl) }
        : {}),
      ...(publicHttpUrl(lighthouse.finalUrl) ? { finalUrl: publicHttpUrl(lighthouse.finalUrl) } : {}),
    };
    if (root.error != null || lighthouse.runtimeError != null || !validScore(categoryResult.score))
      return { ...base, ...metadata, reason: '原始报告缺少有效评分或包含执行错误' };
    const rawAudits = object(lighthouse.audits);
    const refs = Array.isArray(categoryResult.auditRefs) ? categoryResult.auditRefs : [];
    const audits: Audit[] = [];
    for (const ref of refs) {
      const id = object(ref).id;
      if (typeof id !== 'string') continue;
      const audit = object(rawAudits[id]);
      if (typeof audit.title !== 'string') continue;
      const score = validScore(audit.score) ? audit.score : null;
      if ((score === null || score >= 1) && audit.scoreDisplayMode !== 'error') continue;
      audits.push({
        id,
        title: audit.title,
        score,
        ...(typeof audit.scoreDisplayMode === 'string' ? { scoreDisplayMode: audit.scoreDisplayMode } : {}),
        ...(typeof audit.displayValue === 'string' ? { displayValue: audit.displayValue } : {}),
        ...(typeof audit.numericValue === 'number' && Number.isFinite(audit.numericValue)
          ? { numericValue: audit.numericValue }
          : {}),
      });
      if (audits.length === 10) break;
    }
    return {
      ...base,
      ...metadata,
      availability: 'AVAILABLE',
      score: Math.round(categoryResult.score * 100),
      audits,
    };
  } catch {
    return { ...base, reason: '已有报告读取或解析失败，可能超时、地址不可用或超过大小限制' };
  }
}
