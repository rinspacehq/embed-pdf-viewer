// Native Document PiP acceptance for the real EmbedPDF plugin. Uses a synthetic host, not a model.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const output = process.env.READER_EVIDENCE_DIR;
const pdfPath = process.env.READER_TEST_PDF;
const disableDocumentPiP = process.env.READER_DISABLE_DOCUMENT_PIP === 'true';
if (!output || !pdfPath) throw new Error('Set external READER_EVIDENCE_DIR and synthetic READER_TEST_PDF');
await mkdir(output, { recursive: true });
const root = resolve(import.meta.dirname, '../../viewers/snippet/dist');
const pdf = await readFile(pdfPath);
const fragment = process.env.READER_FRAGMENT_FIXTURE ? JSON.parse(await readFile(process.env.READER_FRAGMENT_FIXTURE, 'utf8')) : undefined;
const evidencePages = Number(process.env.READER_EVIDENCE_PAGES || 1);
const evidenceChars = Number(process.env.READER_EVIDENCE_CHARS || 80);
assert.ok(Number.isInteger(evidencePages) && evidencePages > 0 && evidencePages <= 24);
assert.ok(Number.isInteger(evidenceChars) && evidenceChars > 0 && evidenceChars <= 80000);
const expectedHeading = fragment ? 'First' : 'A complete explanation';
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname.startsWith('/fonts/mathjax-newcm/woff2/') && process.env.READER_MATH_FONT_ROOT) {
    const font = pathname.split('/').pop();
    if (!/^[a-z0-9-]+\.woff2$/.test(font)) { response.writeHead(403).end(); return; }
    try { response.setHeader('Content-Type', 'font/woff2'); response.end(await readFile(resolve(process.env.READER_MATH_FONT_ROOT, font))); }
    catch { response.writeHead(404).end(); }
    return;
  }
  if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (pathname === '/' || pathname === '/other') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="zh-CN"><head><title>Native Reader PiP</title></head><body style="margin:0"><div id="viewer" style="height:100dvh"></div></body></html>'); return;
  }
  if (pathname === '/fixture.pdf') { response.setHeader('Content-Type', 'application/pdf'); response.end(pdf); return; }
  const path = resolve(root, '.' + pathname);
  if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  try { response.setHeader('Content-Type', extname(path) === '.wasm' ? 'application/wasm' : 'text/javascript'); response.end(await readFile(path)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const browser = await chromium.launch({ headless: false, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--disable-dev-shm-usage', '--window-size=1440,900'] });
// A fixed Playwright viewport also overrides native PiP, hiding narrow-window bugs.
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
if (disableDocumentPiP) await page.addInitScript(() => {
  Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: undefined });
});
async function useNativeFocus(target) {
  const cdp = await context.newCDPSession(target);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await cdp.detach();
}
const errors = [];
context.on('page', target => target.on('pageerror', error => errors.push(error.message)));
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(20000);
const result = { schema: 'reader-viewer-native-pip/v1', recordedAt: new Date().toISOString(), browser: browser.version(),
  scope: 'Real EmbedPDF PDFium viewer, real Rin plugin and native PiP; synthetic host without paid API or voice.', checks: {} };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await useNativeFocus(page);
  await page.evaluate(async ({ fragment, evidenceChars }) => {
    const { initReader } = await import('/embedpdf.js');
    const snapshots = new Map();
    let sends = 0;
    let accountId = 'synthetic-pip';
    const listeners = new Set();
    window.probe = { get sends() { return sends; }, width: 408, profileDigest: 'b'.repeat(64) };
    window.probe.changeAccount = () => { accountId = 'second-account'; listeners.forEach(listener => listener()); };
    const host = {
      session: () => ({ status: 'authenticated', accountId }),
      panelWidth: () => window.probe.width,
      savePanelWidth: width => { window.probe.width = width; },
      readingContext: () => ({ documentVersion: 'pdf-tree-v1:' + 'a'.repeat(64), profileDigest: window.probe.profileDigest, maxPages: 24, maxChars: evidenceChars }),
      subscribeSession: listener => { listeners.add(listener); return () => listeners.delete(listener); }, login: async () => { throw Error('Unexpected login'); },
      restore: id => snapshots.get(accountId + id), save: (id, value) => snapshots.set(accountId + id, value),
      send: async ({ tools }) => {
        sends++;
        const pages = await tools.readPages([1]);
        window.probe.text = pages[0].text;
        await new Promise(done => { window.probe.finish = done; });
        const reply = { text: '# A complete explanation\n\nThe native PDF remains the source.', pages: [1] };
        if (fragment) {
          const html = fragment.inline.pages[0].fragment;
          reply.lesson = { operationId: '40000000-0000-4000-8000-000000000001', revision: 2, resultHash: fragment.resultHash, html,
            htmlDigest: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html))), byte => byte.toString(16).padStart(2, '0')).join(''),
            view: { schema: 'reader-lesson-view/v1', steps: ['first', 'second'].map(id => ({ id, kind: 'explanation', evidenceRefs: [], narration: [] })), next: 'done' } };
        }
        return reply;
      }, stop: async () => {},
    };
    window.probe.handle = await initReader({ target: document.getElementById('viewer'), wasmUrl: new URL('/pdfium.wasm', location.href).href,
      documentId: 'pip-fixture', title: 'Linear algebra.pdf', buffer: await (await fetch('/fixture.pdf')).arrayBuffer(), host,
      onOpenFile: () => {}, onClose: () => {}, onReady: () => { window.probe.ready = true; }, onViewChange: () => {} });
    window.probe.viewer = document.querySelector('embedpdf-container');
    window.probe.registry = await window.probe.viewer.registry;
  }, { fragment, evidenceChars });
  await page.waitForFunction(() => window.probe?.ready);
  result.checks.evidence = await page.evaluate(async ({ evidencePages, evidenceChars }) => {
    const tools = window.probe.registry.getPlugin('rin').provides().tools('pip-fixture');
    const pages = Array.from({ length: evidencePages }, (_, index) => index + 1);
    if (tools.info().pageCount < evidencePages) throw new Error('Synthetic PDF has fewer pages than the requested test');
    let original = '';
    for (const page of pages) original += (await tools.readPages([page]))[0].text;
    const records = [];
    let text = '', cursor, batches = 0;
    do {
      const arguments_ = { pages, ...(cursor ? { continuation: cursor } : {}) };
      const batch = await tools.readEvidence(pages, cursor);
      records.push({ arguments: arguments_, batch });
      text += batch.pages.map(item => item.text).join('');
      cursor = batch.continuation; batches++;
      if (batches > 100) throw new Error('Evidence continuation did not terminate');
    } while (cursor);
    window.probe.evidenceWireFixture = { schema: 'reader-evidence-wire-fixture/v1', documentVersion: 'pdf-tree-v1:' + 'a'.repeat(64),
      profileDigest: 'b'.repeat(64), maxChars: evidenceChars, sourceText: original, records };
    const first = await tools.readEvidence(pages);
    window.probe.profileDigest = 'c'.repeat(64);
    let rejected = false;
    try { await tools.readEvidence(pages, first.continuation); } catch { rejected = true; }
    window.probe.profileDigest = 'b'.repeat(64);
    return { sameAsNativeText: text === original, characters: text.length, pages: pages.length, maxChars: evidenceChars, batches, rejectsChangedProfile: rejected };
  }, { evidencePages, evidenceChars });
  await writeFile(resolve(output, 'evidence-wire-fixture.json'), JSON.stringify(await page.evaluate(() => window.probe.evidenceWireFixture), null, 2) + '\n', { flag: 'wx' });
  assert.equal(result.checks.evidence.sameAsNativeText, true);
  assert.ok(result.checks.evidence.batches > 1);
  assert.equal(result.checks.evidence.rejectsChangedProfile, true);
  await page.getByRole('button', { name: '琳', exact: true }).click();
  const input = page.getByRole('textbox', { name: '发给琳的消息' });
  const separator = page.getByRole('separator', { name: '调整侧栏宽度' });
  await separator.waitFor();
  if (disableDocumentPiP) {
    assert.equal(await page.getByRole('button', { name: '画中画', exact: true }).count(), 0);
    await input.fill('不支持画中画时保留侧栏草稿。');
    await page.getByRole('button', { name: '收起琳', exact: true }).click();
    await page.getByRole('button', { name: '琳', exact: true }).click();
    assert.equal(await input.inputValue(), '不支持画中画时保留侧栏草稿。');
    result.checks.unsupportedBrowserKeepsSingleSidebar = await page.evaluate(() => ({
      apiUnavailable: window.documentPictureInPicture === undefined,
      panelInOpener: window.probe.viewer.shadowRoot.querySelector('section[aria-label="琳"]')?.ownerDocument === document,
      sends: window.probe.sends,
    }));
    assert.deepEqual(result.checks.unsupportedBrowserKeepsSingleSidebar,
      { apiUnavailable: true, panelInOpener: true, sends: 0 });
    await page.evaluate(() => window.probe.handle.destroy());
  } else {
  assert.equal(await separator.getAttribute('aria-valuenow'), '408');
  await input.fill('A draft survives resizing.');
  await page.evaluate(() => { window.probe.panelBeforeResize = window.probe.viewer.shadowRoot.querySelector('section[aria-label="琳"]'); });
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await separator.getAttribute('aria-valuenow'), '424');
  const grip = await separator.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 100);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 96, grip.y + 100, { steps: 8 });
  await page.mouse.up();
  assert.equal(await separator.getAttribute('aria-valuenow'), '520');
  assert.equal(await page.evaluate(() => window.probe.width), 520);
  const cancelGrip = await separator.boundingBox();
  await page.mouse.move(cancelGrip.x + cancelGrip.width / 2, cancelGrip.y + 100);
  await page.mouse.down();
  await page.mouse.move(cancelGrip.x + cancelGrip.width / 2 - 32, cancelGrip.y + 100);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await separator.getAttribute('aria-valuenow'), '520');
  assert.equal(await input.inputValue(), 'A draft survives resizing.');
  assert.equal(await page.evaluate(() => window.probe.panelBeforeResize === window.probe.viewer.shadowRoot.querySelector('section[aria-label="琳"]')), true);
  assert.equal(await page.evaluate(() => document.documentElement.style.cursor), '');
  await page.getByRole('button', { name: '收起琳', exact: true }).click();
  await page.getByRole('button', { name: '琳', exact: true }).click();
  assert.equal(await separator.getAttribute('aria-valuenow'), '520');
  assert.equal(await input.inputValue(), 'A draft survives resizing.');
  result.checks.resizing = { keyboard: true, pointer: true, escapeRestores: true, width: 520, samePanel: true, draftPreserved: true, collapseRestoresWidth: true };
  await input.fill('Explain the source and keep this session.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => typeof window.probe.finish === 'function');
  await page.evaluate(() => { window.probe.panel = window.probe.viewer.shadowRoot.querySelector('section[aria-label="琳"]'); });
  await page.getByRole('button', { name: '画中画', exact: true }).click();
  await page.waitForFunction(() => !!window.documentPictureInPicture.window);
  const pip = context.pages().find(target => target !== page);
  assert.ok(pip, 'Native PiP page was not exposed by Chromium');
  await pip.getByRole('textbox', { name: '发给琳的消息' }).waitFor();
  await useNativeFocus(pip);
  const pipCDP = await context.newCDPSession(pip);
  const { targetInfo } = await pipCDP.send('Target.getTargetInfo');
  const { windowId } = await pipCDP.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
  await pipCDP.send('Browser.setWindowBounds', { windowId, bounds: { width: 520, height: 640 } });
  await pipCDP.detach();
  result.checks.duringGeneration = await page.evaluate(() => ({ sends: window.probe.sends,
    sameNode: window.probe.panel.ownerDocument === documentPictureInPicture.window.document,
    styles: documentPictureInPicture.window.document.querySelector('div').shadowRoot.querySelectorAll('style').length,
    currentDraft: documentPictureInPicture.window.document.querySelector('div').shadowRoot.querySelector('textarea').value }));
  assert.equal(result.checks.duringGeneration.sameNode, true);
  assert.equal(result.checks.duringGeneration.sends, 1);
  assert.equal(result.checks.duringGeneration.currentDraft, 'Explain the source and keep this session.');
  assert.ok(result.checks.duringGeneration.styles > 0);
  const other = await context.newPage();
  await other.goto(`http://127.0.0.1:${server.address().port}/other`);
  await useNativeFocus(other);
  await other.bringToFront();
  // Playwright normally emulates focus in every page. Disable it for every
  // target above so these checks observe actual native window focus.
  await other.waitForFunction(() => document.hasFocus());
  result.checks.otherTab = await page.evaluate(() => ({ pipOpen: !!documentPictureInPicture.window, openerHidden: document.hidden, openerFocused: document.hasFocus() }));
  assert.equal(result.checks.otherTab.openerFocused, false);
  assert.equal(result.checks.otherTab.pipOpen, true);
  await page.evaluate(() => window.probe.finish());
  await pip.getByRole('heading', { name: expectedHeading }).waitFor();
  if (fragment) {
    await pip.locator('mjx-container').first().waitFor();
    assert.equal(await pip.locator('mjx-container').count(), 2);
    assert.equal(await pip.locator('mjx-assistive-mml math').count(), 2);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${server.address().port}` });
    const lessonHeading = pip.getByRole('heading', { name: expectedHeading, exact: true });
    await lessonHeading.click({ clickCount: 3 });
    await pip.keyboard.press('Control+KeyC');
    assert.equal((await pip.evaluate(() => navigator.clipboard.readText())).trim(), expectedHeading);
    await page.evaluate(() => { window.probe.renderedRoot = window.probe.panel.querySelector('article>div.min-w-0')?.shadowRoot; });
    result.checks.renderedLesson = { actualRendererHTML: true, formulas: 2, assistiveMathML: 2, generatedWhilePoppedOut: true, copiedInPiP: true };
  }
  assert.equal(await page.evaluate(() => window.probe.sends), 1);
  await pip.getByRole('button', { name: '第 1 页', exact: true }).click();
  const draft = pip.getByRole('textbox', { name: '发给琳的消息' });
  await draft.fill('The next question from PiP.');
  const savedDraft = await page.evaluate(() => window.probe.registry.getPlugin('rin').provides().snapshot('pip-fixture').draft);
  assert.equal(savedDraft, 'The next question from PiP.', 'Input must update shared state, not just the DOM value');
  assert.equal(await pip.getByRole('button', { name: '发送', exact: true }).isEnabled(), true);
  result.checks.nativeViewport = await pip.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(result.checks.nativeViewport.width >= 300 && result.checks.nativeViewport.width <= 600);
  await page.evaluate(() => window.probe.viewer.setTheme('dark'));
  await pip.waitForFunction(() => {
    const host = document.querySelector('div');
    return getComputedStyle(host).getPropertyValue('--ep-background-surface').trim() === '#1f2937';
  });
  const background = await pip.locator('section[aria-label="琳"]').evaluate(element => ({ foreground: getComputedStyle(element).color, font: getComputedStyle(element).fontFamily }));
  assert.equal(background.foreground, 'rgb(249, 250, 251)');
  result.checks.themeWhilePoppedOut = background;
  await draft.evaluate(element => element.setSelectionRange(4, 7));
  await pip.screenshot({ path: resolve(output, 'native-pip-dark.png') });
  await pip.close();
  await page.waitForFunction(() => !documentPictureInPicture.window);
  await page.bringToFront();
  assert.equal(await input.inputValue(), 'The next question from PiP.');
  assert.deepEqual(await input.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd })), { start: 4, end: 7 });
  assert.equal(await page.evaluate(() => window.probe.panel === window.probe.viewer.shadowRoot.querySelector('section[aria-label="琳"]')), true);
  await page.getByRole('heading', { name: expectedHeading }).waitFor();
  if (fragment) {
    assert.equal(await page.locator('mjx-container').count(), 2);
    assert.equal(await page.evaluate(() => window.probe.renderedRoot === window.probe.panel.querySelector('article>div.min-w-0')?.shadowRoot), true);
    assert.ok(await page.evaluate(() => document.head.querySelectorAll('style[data-rin-lesson-fonts]').length));
    result.checks.renderedLesson.sameRootAfterReturn = true;
  }
  result.checks.returnedSamePanel = true;
  result.checks.sourceExtracted = (await page.evaluate(() => window.probe.text)).length > 0;
  assert.equal(result.checks.sourceExtracted, true);
  // A second opening followed by viewer teardown must not orphan the native window.
  await page.getByRole('button', { name: '画中画', exact: true }).click();
  await page.waitForFunction(() => !!documentPictureInPicture.window);
  const secondPiP = context.pages().find(target => target !== page && target !== other && !target.isClosed());
  assert.ok(secondPiP);
  await page.evaluate(() => window.probe.changeAccount());
  await secondPiP.waitForFunction(() => document.querySelector('div')?.shadowRoot?.querySelector('textarea')?.value === '');
  assert.equal(await secondPiP.getByRole('heading', { name: expectedHeading }).count(), 0);
  result.checks.accountSwitchClearsPiPContent = true;
  await page.evaluate(() => window.probe.handle.destroy());
  await page.waitForFunction(() => !documentPictureInPicture.window);
  result.checks.teardownClosesNativeWindow = true;
  result.checks.sends = await page.evaluate(() => window.probe.sends);
  assert.equal(result.checks.sends, 1);
  }
  assert.deepEqual(errors, []);
  result.passed = true;
} catch (error) { result.passed = false; result.error = error.stack; process.exitCode = 1; }
finally {
  result.pageErrors = errors;
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise(done => server.close(done));
}
