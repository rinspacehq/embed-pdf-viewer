import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../../viewers/snippet/dist');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const output = process.env.READER_EVIDENCE_DIR;
if (!output) throw new Error('Set READER_EVIDENCE_DIR to an external evidence directory');
await mkdir(output, { recursive: true });

function samplePdf(imageOnly = false) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
  ];
  for (let page = 1; page <= 3; page++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${page * 2 + 2} 0 R >>`);
    const stream = imageOnly
      ? 'q 500 0 0 650 50 50 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID e6e6e6> EI Q'
      : `BT /F1 20 Tf 50 720 Td (Reader test page ${page}) Tj 0 -40 Td (Markdown headings use a hash sign.) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(body + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

const pdf = samplePdf();
await writeFile(resolve(output, 'fixture.pdf'), pdf);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><body style="margin:0"><div id="viewer" style="height:100dvh"></div></body></html>');
    return;
  }
  if (pathname === '/fixture.pdf') { response.setHeader('Content-Type', 'application/pdf'); response.end(pdf); return; }
  if (pathname === '/slow.pdf') { await new Promise(resolve => setTimeout(resolve, 4000)); response.setHeader('Content-Type', 'application/pdf'); response.end(pdf); return; }
  if (pathname === '/scanned.pdf') { response.setHeader('Content-Type', 'application/pdf'); response.end(samplePdf(true)); return; }
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(file);
    response.setHeader('Content-Type', extname(file) === '.wasm' ? 'application/wasm' : 'text/javascript');
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', error => { errors.push(error.message); console.error('browser:', error.message); });
page.on('console', message => { if (message.type() === 'error') console.error('console:', message.text()); });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const embed = await import('/embedpdf.js');
    const buffer = await (await fetch('/fixture.pdf')).arrayBuffer();
    const snapshots = new Map();
    let session = { status: 'authenticated', accountId: 'synthetic-reader' };
    const listeners = new Set();
    window.changeReaderAccount = value => { session = value; listeners.forEach(listener => listener()); };
    window.sendCount = 0;
    const host = {
      session: () => session,
      subscribeSession: listener => { listeners.add(listener); return () => listeners.delete(listener); }, login: async () => { throw new Error('Unexpected login'); },
      restore: id => snapshots.get(session.accountId + id), save: (id, snapshot) => snapshots.set(session.accountId + id, snapshot),
      send: async ({ tools }) => {
        window.sendCount++;
        const pages = await tools.readPages([1]);
        window.extracted = pages[0].text;
        window.documentInfo = tools.info();
        window.selected = await tools.selection();
        window.searchResults = await tools.search('Markdown', [2]);
        await new Promise(resolve => { window.finishSend = resolve; });
        return { text: 'A heading uses #. [p:1]', pages: [1, 3], costSG: 0.000125 };
      }, stop: async () => {},
    };
    window.viewer = embed.default.init({ type: 'container', target: document.getElementById('viewer'),
      documentManager: { initialDocuments: [{ buffer, name: 'Reader test.pdf' }] },
      wasmUrl: new URL('/pdfium.wasm', location.href).href, fonts: { ui: null, signature: null }, fontFallback: null,
      tabBar: 'never', stamp: { manifests: [] }, rin: { host } });
    window.registry = await Promise.race([window.viewer.registry, new Promise((_, reject) => setTimeout(() => reject(new Error('Viewer registry initialization timed out')), 20000))]);
  });
  await page.waitForFunction(() => window.registry?.getPlugin('document-manager').provides().getActiveDocument()?.pageCount === 3);
  await page.evaluate(async () => {
    const id = window.registry.getPlugin('document-manager').provides().getActiveDocumentId();
    await window.registry.getPlugin('selection').provides().forDocument(id).setSelection({ start: { page: 1, index: 0 }, end: { page: 1, index: 17 } }).toPromise();
  });
  const rinButton = page.getByRole('button', { name: '琳', exact: true });
  await rinButton.click();
  const input = page.getByRole('textbox', { name: '发给琳的消息' });
  await input.fill('Explain a Markdown heading.');
  await rinButton.click();
  await input.waitFor({ state: 'hidden' });
  await rinButton.click();
  assert.equal(await input.inputValue(), 'Explain a Markdown heading.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => typeof window.finishSend === 'function');
  await rinButton.click();
  await rinButton.click();
  await page.evaluate(() => window.finishSend());
  await page.getByText('A heading uses #. [p:1]', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.sendCount), 1);
  assert.match(await page.evaluate(() => window.extracted), /Markdown headings/);
  assert.equal(await page.evaluate(() => window.documentInfo.pageCount), 3);
  assert.equal(await page.evaluate(() => window.selected[0].page), 2);
  assert.match(await page.evaluate(() => window.selected[0].text), /Reader test page 2/);
  assert.equal(await page.evaluate(() => window.searchResults[0].page), 2);
  assert.equal(await page.getByRole('button', { name: '第 3 页', exact: true }).count(), 0);
  await page.getByRole('button', { name: '第 1 页', exact: true }).click();
  await page.screenshot({ path: resolve(output, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await input.waitFor({ state: 'visible' });
  await page.screenshot({ path: resolve(output, 'mobile.png') });
  await page.getByRole('button', { name: '收起琳', exact: true }).click();
  await input.waitFor({ state: 'hidden' });
  await page.evaluate(() => window.changeReaderAccount({ status: 'authenticated', accountId: 'another-reader' }));
  await rinButton.click();
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.getByText('A heading uses #. [p:1]', { exact: true }).count(), 0);
  await page.evaluate(() => window.changeReaderAccount({ status: 'anonymous' }));
  await input.fill('Keep this draft when I log in.');
  await page.evaluate(() => window.changeReaderAccount({ status: 'authenticated', accountId: 'new-reader' }));
  assert.equal(await input.inputValue(), 'Keep this draft when I log in.');
  assert.equal(await page.evaluate(() => window.sendCount), 1);
  // Slow native loading must not dispatch a paid host call, even through the
  // programmatic capability. Keep the draft and enable sending after real load.
  const pendingLoad = await page.evaluate(async () => {
    const manager = window.registry.getPlugin('document-manager').provides();
    const id = crypto.randomUUID();
    const opened = await manager.openDocumentUrl({ url: new URL('/slow.pdf', location.href).href, name: 'slow.pdf', documentId: id }).toPromise();
    window.slowDocumentId = id;
    window.slowDocumentLoaded = opened.task.toPromise();
    const rin = window.registry.getPlugin('rin').provides();
    rin.draft(id, 'Wait for this document.');
    await rin.send(id);
    return { ready: rin.ready(id), sends: window.sendCount, draft: rin.snapshot(id).draft, error: rin.snapshot(id).error };
  });
  assert.equal(pendingLoad.ready, false);
  assert.equal(pendingLoad.sends, 1);
  assert.equal(pendingLoad.draft, 'Wait for this document.');
  assert.match(pendingLoad.error, /尚未准备好/);
  await page.waitForFunction(() => window.registry.getPlugin('rin').provides().ready(window.slowDocumentId));
  const loadedText = await page.evaluate(async () => (await window.registry.getPlugin('rin').provides().tools(window.slowDocumentId).readPages([1]))[0].text);
  assert.match(loadedText, /Markdown headings/);
  // Native password-cancel/error-close also closes the host route, not an unbound viewer.
  const closed = await page.evaluate(async () => {
    window.viewer.remove();
    const { initReader } = await import('/embedpdf.js');
    let count = 0;
    const host = { session: () => ({ status: 'anonymous' }), subscribeSession: () => () => {}, login: async () => {}, restore: () => undefined, save: () => {}, send: async () => ({ text: '' }), stop: async () => {} };
    const id = crypto.randomUUID();
    const handle = await initReader({ target: document.getElementById('viewer'), documentId: id, title: 'close.pdf',
      buffer: await (await fetch('/fixture.pdf')).arrayBuffer(), wasmUrl: new URL('/pdfium.wasm', location.href).href,
      host, onOpenFile: () => {}, onClose: () => { count++; }, onReady: () => {}, onViewChange: () => {} });
    const manager = (await document.querySelector('embedpdf-container').registry).getPlugin('document-manager').provides();
    await manager.closeDocument(id).toPromise(); handle.destroy(); return count;
  });
  assert.equal(closed, 1);
  const scanned = await page.evaluate(async () => {
    const { initReader } = await import('/embedpdf.js');
    const host = { session: () => ({ status: 'anonymous' }), subscribeSession: () => () => {}, login: async () => {}, restore: () => undefined, save: () => {}, send: async () => { throw Error('Unexpected model invocation'); }, stop: async () => {} };
    const id = crypto.randomUUID();
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const handle = await initReader({ target: document.getElementById('viewer'), documentId: id, title: 'scanned.pdf',
      buffer: await (await fetch('/scanned.pdf')).arrayBuffer(), wasmUrl: new URL('/pdfium.wasm', location.href).href,
      host, onOpenFile: () => {}, onClose: () => {}, onReady: () => resolveReady(), onViewChange: () => {} });
    await ready;
    const registry = await document.querySelector('embedpdf-container').registry;
    const tools = registry.getPlugin('rin').provides().tools(id);
    const reads = [];
    for (let index = 0; index < 5; index++) reads.push(await tools.readPages([1, 2, 3]));
    const search = await tools.search('Markdown', [1, 2, 3]);
    handle.destroy(); return { reads, search };
  });
  assert(scanned.reads.flat().every(item => item.text === ''));
  assert.deepEqual(scanned.search, []);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ pdfPages: 3, sends: 1, textExtracted: true,
    collapsePreservesDraftAndRun: true, unreadCitationRejected: true, mobileClose: true, loadingBlocksHostSend: true, loadedToolsReady: true, scannedPagesEmpty: true, pageErrors: errors }, null, 2));
  console.log('Native viewer PDF/plugin browser smoke passed.');
} finally {
  await page.screenshot({ path: resolve(output, 'last-state.png') }).catch(() => {});
  await writeFile(resolve(output, 'browser-errors.json'), JSON.stringify(errors));
  await browser.close();
  server.close();
}
