// SPDX-License-Identifier: MIT
import type { RinEvidence, RinEvidenceBatch, RinReadingContext } from './types';

type Cursor = { v: 1; documentVersion: string; profileDigest: string; pages: number[]; index: number; offset: number };

export async function evidenceDigest(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** A continuation is an untrusted read position, never a credential or proof
 * that the server authenticated a local book. No excerpt is silently dropped. */
export async function readBoundedEvidence(pages: number[], context: RinReadingContext, continuation: string | undefined,
  pageCount: number, read: (page: number) => Promise<string>, assertCurrent: () => void): Promise<RinEvidenceBatch> {
  if (!/^pdf-tree-v1:[0-9a-f]{64}$/.test(context.documentVersion) || !/^[0-9a-f]{64}$/.test(context.profileDigest) ||
    !Number.isInteger(context.maxPages) || context.maxPages < 1 || context.maxPages > 24 ||
    !Number.isInteger(context.maxChars) || context.maxChars < 1 || context.maxChars > 80000 ||
    !Array.isArray(pages) || !pages.length || pages.length > context.maxPages || new Set(pages).size !== pages.length ||
    pages.some(page => !Number.isInteger(page) || page < 1 || page > pageCount)) throw new Error('阅读范围或会话预算无效。');
  let index = 0, offset = 0;
  if (continuation !== undefined) {
    try {
      if (continuation.length > 4096) throw new Error();
      const cursor = JSON.parse(atob(continuation)) as Cursor;
      if (cursor.v !== 1 || cursor.documentVersion !== context.documentVersion || cursor.profileDigest !== context.profileDigest ||
        JSON.stringify(cursor.pages) !== JSON.stringify(pages) || !Number.isInteger(cursor.index) || cursor.index < 0 || cursor.index >= pages.length ||
        !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
      index = cursor.index; offset = cursor.offset;
    } catch { throw new Error('续读位置与当前文档或配置不匹配。'); }
  }
  const results: RinEvidence[] = [];
  let remaining = context.maxChars;
  while (index < pages.length && remaining > 0) {
    assertCurrent();
    const page = pages[index];
    const text = await read(page);
    assertCurrent();
    if (offset > text.length || offset > 0 && (offset === text.length || text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff)) {
      throw new Error('续读位置已失效。');
    }
    let end = offset, consumed = 0;
    while (end < text.length && consumed < remaining) { end += text.codePointAt(end)! > 0xffff ? 2 : 1; consumed++; }
    const excerpt = text.slice(offset, end);
    const digest = await evidenceDigest(excerpt);
    assertCurrent();
    const id = 'e-' + await evidenceDigest([context.documentVersion, page, offset, end, digest].join('\0'));
    assertCurrent();
    results.push({ id, page, text: excerpt, digest, documentVersion: context.documentVersion, startUTF16: offset, endUTF16: end,
      kind: text.length ? 'text' : 'text-unavailable', complete: end === text.length });
    remaining -= consumed;
    if (end === text.length) { index++; offset = 0; } else { offset = end; }
  }
  const next = index < pages.length ? btoa(JSON.stringify({ v: 1, documentVersion: context.documentVersion,
    profileDigest: context.profileDigest, pages, index, offset } satisfies Cursor)) : undefined;
  if (next && results.length && !results[results.length - 1].complete) results[results.length - 1].continuation = next;
  return { pages: results, complete: !next, ...(next ? { continuation: next } : {}) };
}
