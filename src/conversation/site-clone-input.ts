/** 网站搬家输入解析，仅处理用户明确提供的网址。@author xiuyu.yi */
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { questionPages } from '../interactions/question-pages.js';
import { InvalidArgumentError } from 'commander';

export function siteUrl(value: string): string {
  const input = value.trim();
  if (!input || /[\s\\<>"']/.test(input))
    throw new InvalidArgumentError('请提供一个完整的网站地址，例如 https://example.com');
  const prefix = input.match(/^https?:\/\//i)?.[0];
  const message = prefix ? `${prefix.toLowerCase()}${input.slice(prefix.length)}` : `https://${input}`;
  try {
    const url = new URL(message);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const labels = hostname.replace(/\.$/, '').split('.');
    const validDomain =
      labels.length >= 2 && labels.every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (!validDomain && !isIP(hostname) && hostname !== 'localhost')
    )
      throw new Error('invalid');
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) && !/^https?:\/\//i.test(input)) throw new Error('protocol');
    if (!/^https?:\/\//i.test(input) && hostname === 'localhost') throw new Error('domain');
    return message;
  } catch {
    throw new InvalidArgumentError('请提供一个有效的网站地址，例如 https://example.com');
  }
}

/** 句子中的网址去掉排版标点，保留网址内部的合法括号和查询参数。 */
function cleanCandidate(value: string) {
  let cleaned = value;
  while (cleaned.endsWith(')') && (cleaned.match(/\)/g)?.length ?? 0) > (cleaned.match(/\(/g)?.length ?? 0))
    cleaned = cleaned.slice(0, -1);
  while (cleaned.endsWith(']') && (cleaned.match(/\]/g)?.length ?? 0) > (cleaned.match(/\[/g)?.length ?? 0))
    cleaned = cleaned.slice(0, -1);
  try {
    siteUrl(cleaned);
    return cleaned;
  } catch {
    return cleaned.replace(/[.,;!?，。；！？]+$/, '');
  }
}

export function prepareSiteCloneInput(content: string, selectedUrl?: string) {
  const originalInput = content.trim();
  const candidates = new Map<string, string>();
  const invalidCandidates: string[] = [];
  const add = (candidate: string): void => {
    try {
      const url = siteUrl(candidate === originalInput ? candidate : cleanCandidate(candidate));
      candidates.set(new URL(url).href, url);
    } catch {
      const separated = candidate.split(/[,;](?=https?:\/\/)/i);
      if (separated.length > 1) {
        for (const part of separated) add(part);
      } else invalidCandidates.push(candidate);
    }
  };
  // 从左到右识别完整链接，路径和查询参数中的网址由外层链接整体消费。
  const tokens = [
    ...originalInput.matchAll(
      /[a-z][a-z\d+.-]*:\/\/[^\s<>"'`，。；！？、]*|(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}(?::\d+)?(?:[/?#][^\s<>"'`，。；！？、]*)?/gi,
    ),
  ];
  for (const match of tokens) {
    const before = originalInput.slice(0, match.index);
    if (before.endsWith('@') || /[a-z\d._-]$/i.test(before)) continue;
    add(match[0]);
  }
  let remaining = originalInput;
  for (const match of [...tokens].reverse()) {
    const start = match.index!;
    remaining =
      remaining.slice(0, start) + ' '.repeat(match[0].length) + remaining.slice(start + match[0].length);
  }
  if (/https?:(?!\/\/)/i.test(remaining)) invalidCandidates.push(originalInput);
  // 完整中文域名和 IP 地址仍沿用相同 URL 校验。
  if (!tokens.length && !/\s/.test(originalInput) && !originalInput.includes('@')) {
    try {
      add(siteUrl(originalInput));
    } catch {
      /* 交由缺少网址引导处理。 */
    }
  }
  const urls = [...candidates.values()];
  if (selectedUrl) {
    let canonical: string;
    try {
      canonical = new URL(siteUrl(selectedUrl)).href;
    } catch {
      throw new InvalidArgumentError('请选择本次输入中的有效网站地址');
    }
    if (!candidates.has(canonical)) throw new InvalidArgumentError('所选网址不属于本次输入，请重新选择');
    return { state: 'READY', url: candidates.get(canonical), originalInput, candidates: urls };
  }
  if (urls.length === 1 && !invalidCandidates.length)
    return {
      state: 'READY',
      url: urls[0],
      originalInput,
      candidates: urls,
      message: `将为你搬家 ${urls[0]}，先读取网站，再生成可预览的页面。`,
    };
  if (urls.length > 1)
    return {
      state: 'NEEDS_SELECTION',
      originalInput,
      candidates: urls,
      invalidCandidates,
      message: '你提供了多个网站，这次先搬哪一个？',
      presentation: questionPages(
        {
          interactionId: `local-clone-input:${createHash('sha256').update(originalInput).digest('hex')}`,
          kind: 'UNSUPPORTED',
          source: {
            roundId: 'local-input',
            messageId: 'local-input',
            contentId: 'website',
            variant: 'local-input',
          },
          actions: [],
          answerSchema: {},
          questions: [
            {
              id: 'website',
              question: '你提供了多个网站，这次先搬哪一个？',
              multiSelect: false,
              allowOther: false,
              options: urls.map((url, index) => ({ index, label: url, description: '作为本次搬家的原站' })),
            },
          ],
        },
        3,
      ),
    };
  if (invalidCandidates.length || /[a-z][a-z\d+.-]*:\/\//i.test(originalInput))
    return {
      state: 'INVALID_URL',
      originalInput,
      candidates: urls,
      invalidCandidates,
      message: '这个网址不完整或格式无效，请重新发送要搬家的网站链接，例如 https://example.com。',
    };
  return {
    state: 'NEEDS_URL',
    originalInput,
    candidates: [],
    message:
      '请提供要搬家的网站链接，例如 https://example.com。如果你想从零开发网站或应用，可以使用「superun 软件开发专家团」。',
  };
}
