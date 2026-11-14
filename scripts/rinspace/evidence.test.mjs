// Tests the actual TypeScript adapter; no language model or user PDF is used.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../viewers/snippet/package.json', import.meta.url));
const ts = require('typescript');
const temporary = await mkdtemp(join(tmpdir(), 'embedpdf-evidence-test-'));
const modulePath = join(temporary, 'evidence.mjs');
const source = await readFile(new URL('../../viewers/snippet/src/plugins/rin/evidence.ts', import.meta.url), 'utf8');
await writeFile(modulePath, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { readBoundedEvidence, evidenceDigest } = await import(pathToFileURL(modulePath).href);
after(() => rm(temporary, { recursive: true, force: true }));
const context = { documentVersion: 'pdf-tree-v1:' + 'a'.repeat(64), profileDigest: 'b'.repeat(64), maxPages: 8, maxChars: 3 };

test('continuations preserve all Unicode text, page order and excerpt digests', async () => {
  const originals = ['甲🙂乙\n数学𝑥=1', '最后一页'];
  const joined = ['', ''];
  let continuation;
  let complete = false;
  for (let i = 0; i < 20 && !complete; i++) {
    const batch = await readBoundedEvidence([1, 2], context, continuation, 2, async page => originals[page - 1], () => {});
    for (const item of batch.pages) {
      joined[item.page - 1] += item.text;
      assert.equal(item.digest, await evidenceDigest(item.text));
      assert.equal(item.text.includes('\ufffd'), false);
      assert.equal(item.documentVersion, context.documentVersion);
      assert.ok(item.id.startsWith('e-'));
      if (!item.complete) assert.equal(item.continuation, batch.continuation);
    }
    continuation = batch.continuation; complete = batch.complete;
  }
  assert.equal(complete, true);
  assert.deepEqual(joined, originals);
});

test('24 pages and 80000 characters leave an explicit tail without over-reading', async () => {
  const pages = Array.from({ length: 24 }, (_, index) => index + 1);
  const teacher = { ...context, maxPages: 24, maxChars: 80000 };
  const calls = [];
  const read = async page => { calls.push(page); return '甲'.repeat(4000); };
  const first = await readBoundedEvidence(pages, teacher, undefined, 24, read, () => {});
  assert.equal(first.pages.reduce((sum, item) => sum + item.text.length, 0), 80000);
  assert.equal(first.complete, false);
  assert.deepEqual(calls, pages.slice(0, 20));
  assert.ok(first.pages.every(item => item.complete));
  const tail = await readBoundedEvidence(pages, teacher, first.continuation, 24, read, () => {});
  assert.equal(tail.complete, true);
  assert.equal(tail.pages.reduce((sum, item) => sum + item.text.length, 0), 16000);
  assert.deepEqual(calls, pages);
  await assert.rejects(readBoundedEvidence(pages, context, undefined, 24, read, () => {}));
  assert.equal(calls.length, 24, 'ordinary budget rejection must happen before reading');
});

test('a cursor cannot cross a document, profile or requested page order', async () => {
  const first = await readBoundedEvidence([1, 2], context, undefined, 2, async () => 'abcdef', () => {});
  let reads = 0;
  for (const [pages, config] of [
    [[1, 2], { ...context, documentVersion: 'pdf-tree-v1:' + 'c'.repeat(64) }],
    [[1, 2], { ...context, profileDigest: 'd'.repeat(64) }],
    [[2, 1], context],
  ]) await assert.rejects(readBoundedEvidence(pages, config, first.continuation, 2, async () => { reads++; return ''; }, () => {}));
  assert.equal(reads, 0);
  const forged = JSON.parse(atob(first.continuation));
  forged.offset = 2; // The middle of the surrogate pair in 甲🙂乙.
  await assert.rejects(readBoundedEvidence([1, 2], context, btoa(JSON.stringify(forged)), 2, async () => '甲🙂乙', () => {}));
});

test('a switched session cannot deliver an in-flight PDF extraction', async () => {
  let resolve;
  let switched = false;
  const pending = readBoundedEvidence([1], context, undefined, 1, () => new Promise(done => { resolve = done; }), () => {
    if (switched) throw new Error('session changed');
  });
  switched = true; resolve('private old document text');
  await assert.rejects(pending, /session changed/);
});

test('scan-only pages report unavailable text without fabricated characters', async () => {
  const batch = await readBoundedEvidence([1], context, undefined, 1, async () => '', () => {});
  assert.equal(batch.complete, true);
  assert.equal(batch.pages[0].kind, 'text-unavailable');
  assert.equal(batch.pages[0].text, '');
  assert.equal(batch.pages[0].digest, await evidenceDigest(''));
});
