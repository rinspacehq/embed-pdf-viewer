// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const output = process.env.READER_EVIDENCE_DIR;
if (!output) throw new Error('Set READER_EVIDENCE_DIR to an external evidence directory');
await mkdir(output, { recursive: true });
const dist = resolve(import.meta.dirname, '../../viewers/snippet/dist');

const pageCount = 16;
function fixture() {
  const object = value => Buffer.from(value);
  const stream = (data, fields = '') => Buffer.concat([
    object(`<< /Length ${data.length} ${fields} >>\nstream\n`),
    Buffer.from(data), object('\nendstream'),
  ]);
  const font = 3 + pageCount * 2;
  const image = font + 1;
  const kids = Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`);
  const objects = [
    object('<< /Type /Catalog /Pages 2 0 R >>'),
    object(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`),
  ];
  for (let index = 0; index < pageCount; index++) {
    const tail = index === pageCount - 1;
    const xObject = tail ? `/XObject << /I ${image} 0 R >>` : '';
    objects.push(object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F ${font} 0 R >> ${xObject} >> /Contents ${4 + index * 2} 0 R >>`));
    const text = `BT /F 32 Tf 70 690 Td (Range test page ${index + 1}) Tj ET`;
    objects.push(stream(text + (tail ? ' q 500 0 0 500 56 130 cm /I Do Q' : '')));
  }
  objects.push(object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  objects.push(stream(Buffer.alloc(2048 * 2048 * 3, 105),
    '/Type /XObject /Subtype /Image /Width 2048 /Height 2048 /ColorSpace /DeviceRGB /BitsPerComponent 8'));
  const parts = [object('%PDF-1.5\n')];
  const offsets = ['0000000000 65535 f \n'];
  let position = parts[0].length;
  for (const [index, value] of objects.entries()) {
    offsets.push(`${String(position).padStart(10, '0')} 00000 n \n`);
    const block = Buffer.concat([object(`${index + 1} 0 obj\n`), value, object('\nendobj\n')]);
    parts.push(block);
    position += block.length;
  }
  parts.push(object(`xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));
  return Buffer.concat(parts);
}

const pdf = fixture();
const etag = `"sha256-${createHash('sha256').update(pdf).digest('hex')}"`;
const requests = [];
let mode = 'read';
let held;
let serverClosed;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><body style="margin:0"><div id="viewer" style="height:100dvh"></div>');
    return;
  }
  if (pathname === '/file.pdf') {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
    if (mode === 'deny' || request.headers['x-fixture-access'] !== 'synthetic' || request.headers['if-match'] !== etag || !range) {
      requests.push({ status: 404, bytes: 0 });
      response.writeHead(404).end();
      return;
    }
    const start = Number(range[1]);
    const end = Number(range[2]);
    assert(start <= end && end < pdf.length);
    const bytes = pdf.subarray(start, end + 1);
    requests.push({ status: 206, bytes: mode === 'hold' ? 0 : bytes.length, start });
    response.writeHead(206, {
      'Content-Type': 'application/pdf', 'Content-Length': bytes.length,
      'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${pdf.length}`,
      'Cache-Control': 'private, no-store', ETag: mode === 'wrong' ? '"changed"' : etag,
    });
    if (mode === 'hold') {
      response.once('close', serverClosed.resolve);
      response.flushHeaders();
      held.resolve();
      return;
    }
    response.end(bytes);
    return;
  }
  const file = resolve(dist, '.' + pathname);
  if (!file.startsWith(dist + sep)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
page.setDefaultTimeout(18000);
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));

async function open() {
  requests.length = 0;
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async ({ bytes, etag }) => {
    const { initReader } = await import('/embedpdf.js');
    window.failure = [];
    window.abortReading = new AbortController();
    const host = {
      session: () => ({ status: 'anonymous' }), subscribeSession: () => () => {},
      login: async () => {}, restore: () => undefined, save: () => {},
      send: async () => {}, stop: () => {},
    };
    window.reader = await initReader({
      target: document.querySelector('#viewer'), wasmUrl: '/pdfium.wasm',
      documentId: 'publication-pdf-fixture', title: 'Synthetic book', host,
      signal: window.abortReading.signal,
      rangeSource: { url: '/file.pdf', bytes, etag, headers: { 'X-Fixture-Access': 'synthetic' } },
      onOpenFile: () => {}, onClose: () => {}, onViewChange: () => {},
      onReady: value => { window.pageCount = value; },
      onRangeError: status => { window.failure.push(status); },
    });
    window.registry = await document.querySelector('embedpdf-container')?.registry;
  }, { bytes: pdf.length, etag });
}
async function pixels(index) {
  return page.evaluate(async pageIndex => {
    const render = window.registry.getPlugin('render').provides().forDocument('publication-pdf-fixture');
    const blob = await render.renderPage({ pageIndex, options: { scaleFactor: 0.5 } }).toPromise();
    const image = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const rgba = ctx.getImageData(0, 0, image.width, image.height).data;
    image.close();
    let dark = 0;
    for (let offset = 0; offset < rgba.length; offset += 4) {
      if (rgba[offset] < 180 && rgba[offset + 3]) dark++;
    }
    return dark;
  }, index);
}
const verifyReady = async () => {
  await page.waitForFunction(count => window.pageCount === count, pageCount);
  assert(await pixels(0) > 200);
  assert(requests.length > 0 && requests.every(item => item.status === 206));
};
const renderTail = () => pixels(pageCount - 1).catch(() => undefined);
async function within(promise, ms, message) {
  const timer = new AbortController();
  try {
    await Promise.race([promise, delay(ms, undefined, { signal: timer.signal }).then(() => { throw new Error(message); })]);
  } finally {
    timer.abort();
  }
}

try {
  await open();
  await verifyReady();
  const firstPageBytes = requests.reduce((sum, item) => sum + item.bytes, 0);
  assert(firstPageBytes < pdf.length / 8, `first page fetched ${firstPageBytes} of ${pdf.length} bytes`);
  await page.screenshot({ path: resolve(output, 'range-first-page.png') });
  assert(await pixels(pageCount - 1) > 5000);
  assert(requests.reduce((sum, item) => sum + item.bytes, 0) > firstPageBytes);

  await open();
  await verifyReady();
  mode = 'deny';
  await renderTail();
  await page.waitForFunction(() => window.failure[0] === 404);
  assert.equal(await page.locator('embedpdf-container').count(), 0);

  mode = 'read';
  await open();
  await verifyReady();
  mode = 'hold';
  held = Promise.withResolvers();
  serverClosed = Promise.withResolvers();
  const reading = renderTail();
  await within(held.promise, 5000, 'Expected a pending range request');
  await page.evaluate(() => window.abortReading.abort());
  await within(serverClosed.promise, 5000, 'Closing Reader left an HTTP request running');
  await reading;
  assert.deepEqual(await page.evaluate(() => window.failure), []);
  assert.equal(await page.locator('embedpdf-container').count(), 0);

  mode = 'wrong';
  await open();
  await page.waitForFunction(() => window.failure[0] === 0);
  assert.equal(await page.locator('embedpdf-container').count(), 0);
  assert.deepEqual(browserErrors, []);
  const evidence = { fileBytes: pdf.length, firstPageBytes, farPage: true, revoked: 404, canceled: true, rejectedChangedETag: true };
  await writeFile(resolve(output, 'range-test.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(evidence);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
