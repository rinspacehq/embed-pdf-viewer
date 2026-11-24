import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

// READER_ACTUAL_ZOOM_200=true is an opt-in accessibility check. Run it with
// READER_HEADED=true under an X server with xdotool; no browser is downloaded.
const root = resolve(import.meta.dirname, '../../viewers/snippet/dist');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const output = process.env.READER_EVIDENCE_DIR;
const actualZoom200 = process.env.READER_ACTUAL_ZOOM_200 === 'true';
if (!output) throw new Error('Set READER_EVIDENCE_DIR to an external evidence directory');
if (actualZoom200 && process.env.READER_HEADED !== 'true') throw new Error('Actual browser zoom requires READER_HEADED=true');
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
    response.end('<!doctype html><html><head><title>Reader learning browser smoke</title></head><body style="margin:0"><div id="viewer" style="height:100dvh"></div></body></html>');
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
const browser = await chromium.launch({ headless: process.env.READER_HEADED !== 'true', executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--disable-dev-shm-usage'] });
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
    let voiceState = { input: 'idle', transcript: '' };
    let conversationVersion = 0;
    const publish = () => listeners.forEach(listener => listener());
    window.voicePlaySources = [];
    const voice = {
      available: () => true,
      snapshot: () => voiceState,
      startInput: async () => { voiceState = { input: 'review', transcript: '两个非零像量。' }; publish(); },
      finishInput: async () => {}, cancelInput: async () => { voiceState = { input: 'idle', transcript: '' }; publish(); },
      dismissTranscript: async () => { voiceState = { input: 'idle', transcript: '' }; publish(); },
      confirmTranscript: async text => {
        const id = window.registry.getPlugin('document-manager').provides().getActiveDocumentId();
        const snapshot = snapshots.get(session.accountId + id) || { messages: [], draft: '', running: false };
        const corrected = text.trim();
        const draft = snapshot.draft ? `${snapshot.draft}\n${corrected}` : corrected;
        snapshots.set(session.accountId + id, { ...snapshot, draft });
        voiceState = { input: 'error', transcript: '', error: '结果待确认，请重试。', cleanupPending: true }; publish();
        return draft;
      },
      play: async sources => { window.voicePlaySources.push(structuredClone(sources)); },
      stopPlayback: async () => {},
      setFollow: follow => { voiceState = { ...voiceState, playback: { ...voiceState.playback, follow } }; publish(); },
      evidencePages: () => [2],
    };
    window.changeReaderAccount = value => { session = value; listeners.forEach(listener => listener()); };
    const lessonFixture = async (operationId, resultHash, text) => {
      const html = `<div id="fragment-step-one"><p>${text}</p></div>`;
      const bytes = new TextEncoder().encode(html);
      const htmlDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      return { operationId, revision: 2,
        view: { schema: 'reader-lesson-view/v1', steps: [{ id: 'step-one', kind: 'explanation', evidenceRefs: ['page-two'], narration: [text] }], next: 'done' },
        html, htmlDigest, resultHash };
    };
    window.installLessonFixture = async mode => {
      const id = window.registry.getPlugin('document-manager').provides().getActiveDocumentId();
      const lesson = await lessonFixture('71000000-0000-4000-8000-000000000001', 'a'.repeat(64), 'Two vectors form a basis.');
      const snapshot = snapshots.get(session.accountId + id) || { messages: [], draft: '', running: false };
      snapshots.set(session.accountId + id, { ...snapshot,
        messages: [...snapshot.messages.filter(message => !message.lesson), { role: 'assistant', text: '', lesson }] });
      const source = { operationId: lesson.operationId, stepId: 'step-one', narrationIndex: 0,
        lessonResultHash: mode === 'matching-resume' ? lesson.resultHash : 'b'.repeat(64) };
      voiceState = { input: 'idle', transcript: '', playback: { state: mode === 'stale-playing' ? 'playing' : 'idle',
        source: mode === 'stale-playing' ? source : undefined, resumeSource: mode === 'matching-resume' ? source : undefined,
        receivedSamples: 24000, playedSamples: 12000, follow: true } };
      conversationVersion++;
      publish();
      return { operationId: lesson.operationId, resultHash: lesson.resultHash, source };
    };
    window.installLessonBranchFixture = async () => {
      const id = window.registry.getPlugin('document-manager').provides().getActiveDocumentId();
      const main = await lessonFixture('71000000-0000-4000-8000-000000000011', 'c'.repeat(64), 'Original lesson narration.');
      const branch = await lessonFixture('71000000-0000-4000-8000-000000000012', 'd'.repeat(64), 'Branch answer narration.');
      const snapshot = snapshots.get(session.accountId + id) || { messages: [], draft: '', running: false };
      snapshots.set(session.accountId + id, { ...snapshot, messages: [...snapshot.messages.filter(message => !message.lesson),
        { role: 'assistant', text: '', lesson: main }, { role: 'assistant', text: '', lesson: branch }] });
      const resumeSource = { operationId: main.operationId, stepId: 'step-one', narrationIndex: 0, lessonResultHash: main.resultHash };
      voiceState = { input: 'idle', transcript: '', playback: { state: 'idle', resumeSource,
        receivedSamples: 24000, playedSamples: 12000, follow: true } };
      conversationVersion++;
      publish();
      return { main: { operationId: main.operationId, resultHash: main.resultHash }, branch: { operationId: branch.operationId, resultHash: branch.resultHash } };
    };
    window.sendCount = 0;
    window.installRecoverableFixture = value => {
      const id = window.registry.getPlugin('document-manager').provides().getActiveDocumentId();
      const key = session.accountId + id;
      const snapshot = snapshots.get(key) || { messages: [], draft: '', running: false };
      snapshots.set(key, value
        ? { ...snapshot, running: false, recoverable: true, error: '生成中断，请重试。', pendingRequest: { message: 'Continue the interrupted answer.' } }
        : { ...snapshot, running: false, recoverable: false, error: undefined, pendingRequest: undefined });
      conversationVersion++;
      publish();
    };
    window.installTerminalFailureFixture = () => {
      const id = window.registry.getPlugin('document-manager').provides().getActiveDocumentId();
      const key = session.accountId + id;
      const snapshot = snapshots.get(key) || { messages: [], draft: '', running: false };
      snapshots.set(key, { ...snapshot, running: false, recoverable: false, error: '回答渲染失败，请重试。',
        pendingRequest: { message: 'Introduce this book.' } });
      conversationVersion++;
      publish();
    };
    const host = {
      session: () => session,
      subscribeSession: listener => { listeners.add(listener); return () => listeners.delete(listener); }, login: async () => { throw new Error('Unexpected login'); },
      restore: id => snapshots.get(session.accountId + id), save: (id, snapshot) => snapshots.set(session.accountId + id, snapshot),
      conversationVersion: () => String(conversationVersion),
      voice: () => voice,
      send: async ({ tools }) => {
        window.sendCount++;
        const pages = await tools.readPages([1]);
        window.extracted = pages[0].text;
        window.documentInfo = tools.info();
        window.selected = await tools.selection();
        window.searchResults = await tools.search('Markdown', [2]);
        await new Promise(resolve => { window.finishSend = resolve; });
        return { text: '# Reader answer\n\n- **Heading** uses `#`. [p:1]\n\n| Page | Topic |\n| --- | --- |\n| 1 | Markdown |\n\nInline $x_1^2$, and inline \\(z_0\\).\n\n$$\n\\frac{a}{b}\n$$\n\nCode: `$literal$`.\n\n<img src="https://invalid.example/tracker" onerror="window.readerXss=true">', pages: [1, 3], costSG: 0.000125 };
      }, stop: async () => {},
    };
    window.viewer = embed.default.init({ type: 'container', target: document.getElementById('viewer'),
      documentManager: { initialDocuments: [{ buffer, name: 'Reader test.pdf' }] },
      wasmUrl: new URL('/pdfium.wasm', location.href).href, fonts: { ui: null, signature: null }, fontFallback: null,
      tabBar: 'never', stamp: { manifests: [] }, rin: { host } });
    window.registry = await Promise.race([window.viewer.registry, new Promise((_, reject) => setTimeout(() => reject(new Error('Viewer registry initialization timed out')), 20000))]);
    window.originalDocumentId = window.registry.getPlugin('document-manager').provides().getActiveDocumentId();
  });
  await page.waitForFunction(() => window.registry?.getPlugin('document-manager').provides().getActiveDocument()?.pageCount === 3);
  await page.evaluate(async () => {
    const id = window.registry.getPlugin('document-manager').provides().getActiveDocumentId();
    await window.registry.getPlugin('selection').provides().forDocument(id).setSelection({ start: { page: 1, index: 0 }, end: { page: 1, index: 17 } }).toPromise();
  });
  const rinButton = page.getByRole('button', { name: '琳', exact: true });
  await rinButton.click();
  const input = page.getByRole('textbox', { name: '发给琳的消息' });
  const newConversation = page.getByRole('button', { name: '新对话', exact: true });
  await newConversation.waitFor();
  assert.equal(await newConversation.isDisabled(), true);
  assert.match((await newConversation.textContent()).trim(), /新对话/);
  await page.getByRole('button', { name: '琳设置', exact: true }).click();
  await page.getByRole('heading', { name: '琳设置', exact: true }).waitFor();
  assert.equal((await page.getByText('可用', { exact: true }).count()), 1);
  assert.ok(Number(await page.getByRole('slider', { name: '琳面板宽度', exact: true }).inputValue()) >= 320);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const voiceButton = page.getByRole('button', { name: '语音', exact: true });
  assert.equal((await voiceButton.textContent()).trim(), '');
  assert.equal(await voiceButton.locator('svg').count(), 1);
  await voiceButton.click();
  const voiceText = page.getByRole('textbox', { name: '语音文字', exact: true });
  await voiceText.waitFor();
  assert.equal(await voiceText.inputValue(), '两个非零像量。');
  await voiceText.fill('两个非零向量。');
  await page.getByRole('button', { name: '加入消息', exact: true }).click();
  await voiceText.waitFor({ state: 'hidden' });
  assert.equal(await input.inputValue(), '两个非零向量。');
  await page.getByText('结果待确认，请重试。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '确认停止', exact: true }).click();
  await page.getByRole('button', { name: '语音', exact: true }).waitFor();
  await input.fill('Explain a Markdown heading.');
  await rinButton.click();
  await input.waitFor({ state: 'hidden' });
  await rinButton.click();
  assert.equal(await input.inputValue(), 'Explain a Markdown heading.');
  const sendGeneration = page.getByRole('button', { name: '发送', exact: true });
  assert.equal((await sendGeneration.textContent()).trim(), '');
  assert.equal(await sendGeneration.locator('svg').count(), 1);
  assert.equal(await page.locator('[data-rin-primary-action]').count(), 1);
  const primaryBeforeHover = await sendGeneration.evaluate(element => {
    const style = getComputedStyle(element); return { background: style.backgroundColor, color: style.color };
  });
  await sendGeneration.hover();
  await page.waitForFunction(() => {
    const button = window.viewer.shadowRoot.querySelector('[data-rin-primary-action="send"]');
    return button && Number(getComputedStyle(button).opacity) === .84;
  });
  const primaryAfterHover = await sendGeneration.evaluate(element => {
    const style = getComputedStyle(element); return { background: style.backgroundColor, color: style.color, opacity: style.opacity };
  });
  assert.equal(primaryAfterHover.background, primaryBeforeHover.background);
  assert.equal(primaryAfterHover.color, primaryBeforeHover.color);
  assert.equal(primaryAfterHover.opacity, '0.84');
  await sendGeneration.click();
  await page.waitForFunction(() => typeof window.finishSend === 'function');
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.getByText('Explain a Markdown heading.', { exact: true }).count(), 1);
  await input.fill('Keep this next question as a draft.');
  const stopGeneration = page.getByRole('button', { name: '停止生成', exact: true });
  await stopGeneration.waitFor();
  assert.equal((await stopGeneration.textContent()).trim(), '');
  assert.equal(await stopGeneration.locator('svg').count(), 1);
  assert.equal(await page.locator('[data-rin-primary-action]').count(), 1);
  assert.equal(await page.getByRole('button', { name: '发送', exact: true }).count(), 0);
  await rinButton.click();
  await rinButton.click();
  await page.evaluate(() => window.finishSend());
  await page.getByRole('heading', { name: 'Reader answer' }).last().waitFor();
  assert.equal(await input.inputValue(), 'Keep this next question as a draft.');
  assert.equal(await page.locator('.rin-markdown strong').allTextContents().then(items => items.includes('Heading')), true);
  assert.equal(await page.locator('.rin-markdown table td').count(), 2);
  assert.equal(await page.locator('.rin-markdown math msubsup').count(), 1);
  assert.equal(await page.locator('.rin-markdown math msub').count(), 1);
  assert.equal(await page.locator('.rin-markdown math[display="block"] mfrac').count(), 1);
  assert.equal(await page.locator('.rin-markdown code').filter({ hasText: '$literal$' }).count(), 1);
  assert.equal(await page.locator('.rin-markdown img').count(), 0);
  assert.equal(await page.evaluate(() => window.readerXss === true), false);
  assert.equal(await page.evaluate(() => window.sendCount), 1);
  await page.evaluate(() => window.installTerminalFailureFixture());
  const terminalRetry = page.getByRole('button', { name: '重试', exact: true });
  await terminalRetry.waitFor();
  assert.equal(await page.getByRole('button', { name: '放弃恢复', exact: true }).count(), 0);
  await terminalRetry.click();
  await page.waitForFunction(() => window.sendCount === 2 && typeof window.finishSend === 'function');
  await page.evaluate(() => window.finishSend());
  await page.getByRole('heading', { name: 'Reader answer' }).last().waitFor();
  await page.evaluate(() => window.installRecoverableFixture(true));
  const retryGeneration = page.getByRole('button', { name: '重试', exact: true });
  await retryGeneration.waitFor();
  assert.equal(await page.locator('[data-rin-primary-action]').count(), 1);
  assert.equal(await page.getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '停止生成', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '继续生成', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '放弃恢复', exact: true }).count(), 1);
  await page.evaluate(() => window.installRecoverableFixture(false));
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.match(await page.evaluate(() => window.extracted), /Markdown headings/);
  assert.equal(await page.evaluate(() => window.documentInfo.pageCount), 3);
  assert.equal(await page.evaluate(() => window.selected[0].page), 2);
  assert.match(await page.evaluate(() => window.selected[0].text), /Reader test page 2/);
  assert.equal(await page.evaluate(() => window.searchResults[0].page), 2);
  assert.equal(await page.getByRole('button', { name: '第 3 页', exact: true }).count(), 0);
  const lessonFixture = await page.evaluate(() => window.installLessonFixture('matching-resume'));
  const continueNarration = page.getByRole('button', { name: '继续朗读', exact: true });
  await continueNarration.waitFor();
  assert.equal((await continueNarration.textContent()).trim(), '');
  assert.equal(await continueNarration.locator('svg').count(), 1);
  await continueNarration.click();
  assert.deepEqual(await page.evaluate(() => window.voicePlaySources.at(-1)), [{ operationId: lessonFixture.operationId,
    stepId: 'step-one', narrationIndex: 0, lessonResultHash: lessonFixture.resultHash }]);
  await page.evaluate(() => window.installLessonFixture('stale-playing'));
  await page.getByRole('button', { name: '朗读', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '继续朗读', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '停止朗读', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '跟随', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll('div'))
    .find(element => element.shadowRoot?.getElementById('fragment-step-one'))?.shadowRoot
    ?.getElementById('fragment-step-one')?.getAttribute('aria-current') || null), null);
  const branchFixture = await page.evaluate(() => window.installLessonBranchFixture());
  await page.getByText('Branch answer narration.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '继续朗读', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '朗读', exact: true }).count(), 1);
  await page.getByRole('button', { name: '继续朗读', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.voicePlaySources.at(-1)), [{ operationId: branchFixture.main.operationId,
    stepId: 'step-one', narrationIndex: 0, lessonResultHash: branchFixture.main.resultHash }]);
  const aria = await page.locator('section[aria-label="琳"]').ariaSnapshot();
  assert.match(aria, /Original lesson narration\./);
  assert.match(aria, /textbox "发给琳的消息"/);
  assert.match(aria, /button "继续朗读"/);
  const lessonText = page.getByText('Original lesson narration.', { exact: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${server.address().port}` });
  await lessonText.click({ clickCount: 3 });
  const selection = await lessonText.evaluate(element => {
    const root = element.getRootNode();
    window.copyProbe = undefined; window.copyKeyProbe = [];
    const recordKey = event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') window.copyKeyProbe.push({ target: event.target?.tagName || '', defaultPrevented: event.defaultPrevented }); };
    element.addEventListener('keydown', recordKey, { capture: true });
    root.addEventListener('keydown', recordKey, { capture: true });
    document.addEventListener('keydown', recordKey, { capture: true });
    const record = event => { window.copyProbe ||= { selected: root.getSelection?.()?.toString() || document.getSelection()?.toString() || '', defaultPrevented: event.defaultPrevented }; };
    element.addEventListener('copy', record, { capture: true, once: true });
    root.addEventListener('copy', record, { capture: true, once: true });
    document.addEventListener('copy', record, { capture: true, once: true });
    return { shadow: root.getSelection?.()?.toString() || '', document: document.getSelection()?.toString() || '' };
  });
  assert.match(selection.shadow || selection.document, /Original lesson narration\./);
  await page.keyboard.press('Control+KeyC');
  const copy = await page.evaluate(async () => ({ event: window.copyProbe, keys: window.copyKeyProbe, clipboardReadback: await navigator.clipboard.readText() }));
  assert.ok(copy.keys.length, `Ctrl+C did not reach the lesson focus path: ${JSON.stringify(copy)}`);
  assert.match(copy.event?.selected || '', /Original lesson narration\./, `Copy event did not use the lesson selection: ${JSON.stringify(copy)}`);
  assert.equal(copy.event?.defaultPrevented, false);
  if (copy.clipboardReadback) assert.equal(copy.clipboardReadback.trim(), 'Original lesson narration.');
  await page.getByRole('button', { name: '第 1 页', exact: true }).last().click();
  const settledLayout = async () => {
    const result = await page.waitForFunction(async () => {
      const measure = () => {
        const panel = Array.from(document.querySelectorAll('embedpdf-container'))
          .map(element => element.shadowRoot?.querySelector('section[aria-label="琳"]')).find(Boolean);
        const box = panel?.querySelector('textarea[aria-label="发给琳的消息"]')?.getBoundingClientRect();
        return {
          width: innerWidth,
          noPageOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          inputWithinViewport: Boolean(box && box.width > 0 && box.height > 0 && box.left >= 0 &&
            box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight),
        };
      };
      const first = measure();
      if (!first.inputWithinViewport || !first.noPageOverflow) return false;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const next = measure();
      return next.inputWithinViewport && next.noPageOverflow && next.width === first.width && next;
    });
    return result.jsonValue();
  };
  const layouts = [await settledLayout()];
  assert.deepEqual(layouts[0], { width: 1440, noPageOverflow: true, inputWithinViewport: true });
  await page.screenshot({ path: resolve(output, 'desktop.png') });
  let zoom200 = null;
  await page.setViewportSize({ width: 768, height: 900 });
  layouts.push(await settledLayout());
  assert.deepEqual(layouts[1], { width: 768, noPageOverflow: true, inputWithinViewport: true });
  await page.screenshot({ path: resolve(output, 'tablet.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  layouts.push(await settledLayout());
  assert.deepEqual(layouts[2], { width: 390, noPageOverflow: true, inputWithinViewport: true });
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
  assert.equal(await page.evaluate(() => window.sendCount), 2);
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
  assert.equal(pendingLoad.sends, 2);
  assert.equal(pendingLoad.draft, 'Wait for this document.');
  assert.match(pendingLoad.error, /尚未准备好/);
  await rinButton.click();
  const pendingSend = page.getByRole('button', { name: '发送', exact: true });
  assert.equal(await pendingSend.isDisabled(), true);
  assert.equal((await pendingSend.textContent()).trim(), '');
  assert.equal(await pendingSend.locator('svg').count(), 1);
  await page.waitForFunction(() => window.registry.getPlugin('rin').provides().ready(window.slowDocumentId));
  assert.equal(await pendingSend.isDisabled(), false);
  const loadedText = await page.evaluate(async () => (await window.registry.getPlugin('rin').provides().tools(window.slowDocumentId).readPages([1]))[0].text);
  assert.match(loadedText, /Markdown headings/);
  if (actualZoom200) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      window.changeReaderAccount({ status: 'authenticated', accountId: 'synthetic-reader' });
      const documents = window.registry.getPlugin('document-manager').provides();
      documents.setActiveDocument(window.originalDocumentId);
      const documentId = window.originalDocumentId;
      const ui = window.registry.getPlugin('ui').provides().forDocument(documentId);
      if (!ui.isSidebarOpen('right', 'main', 'rin-panel')) ui.toggleSidebar('right', 'main', 'rin-panel');
      window.viewer.setTheme('dark');
    });
    await page.waitForFunction(() => window.registry.getPlugin('document-manager').provides().getActiveDocumentId() === window.originalDocumentId);
    await waitForInputInViewport();
    await page.bringToFront();
    const ids = execFileSync('xdotool', ['search', '--name', 'Reader learning browser smoke - Chromium'], { encoding: 'utf8' }).trim().split(/\s+/);
    const windowId = ids.at(-1);
    assert.ok(windowId, 'Chromium window was not found for actual zoom');
    for (let index = 0; index < 5; index++) execFileSync('xdotool', ['key', '--window', windowId, '--clearmodifiers', 'ctrl+plus']);
    await page.waitForFunction(() => devicePixelRatio === 2 && innerWidth === 720);
    await waitForInputInViewport();
    await lessonText.scrollIntoViewIfNeeded();
    await lessonText.waitFor({ state: 'visible' });
    const box = await input.boundingBox();
    zoom200 = await page.evaluate(() => {
      const panel = Array.from(document.querySelectorAll('embedpdf-container')).map(element => element.shadowRoot?.querySelector('section[aria-label="琳"]')).find(Boolean);
      const panelBox = panel?.getBoundingClientRect();
      return { innerWidth, innerHeight, devicePixelRatio,
        noPageOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        theme: { surface: getComputedStyle(window.viewer).getPropertyValue('--ep-background-surface').trim(),
          foreground: panel ? getComputedStyle(panel).color : null },
        panel: panel ? { x: panelBox.x, y: panelBox.y, width: panelBox.width, height: panelBox.height,
          display: getComputedStyle(panel).display, visibility: getComputedStyle(panel).visibility } : null };
    });
    zoom200.inputWithinViewport = Boolean(box && box.x >= 0 && box.x + box.width <= zoom200.innerWidth &&
      box.y >= 0 && box.y + box.height <= zoom200.innerHeight);
    zoom200.inputBox = box;
    assert.equal(zoom200.innerWidth, 720);
    assert.equal(zoom200.innerHeight, 450);
    assert.equal(zoom200.devicePixelRatio, 2);
    assert.equal(zoom200.noPageOverflow, true);
    assert.deepEqual(zoom200.theme, { surface: '#1f2937', foreground: 'rgb(249, 250, 251)' });
    assert.equal(zoom200.inputWithinViewport, true, JSON.stringify(zoom200));
    zoom200.lessonVisible = await lessonText.isVisible();
    assert.equal(zoom200.lessonVisible, true);
    await input.focus();
    await page.keyboard.press('Tab');
    zoom200.keyboardFocus = await page.evaluate(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      const box = active instanceof HTMLElement ? active.getBoundingClientRect() : null;
      return { tag: active?.tagName || null, label: active instanceof HTMLElement ? active.getAttribute('aria-label') || active.textContent?.trim() || null : null,
        withinViewport: Boolean(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.x + box.width <= innerWidth && box.y >= 0 && box.y + box.height <= innerHeight) };
    });
    assert.equal(zoom200.keyboardFocus.tag, 'BUTTON');
    assert.equal(zoom200.keyboardFocus.withinViewport, true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active instanceof HTMLElement ? active.getAttribute('aria-label') : null;
    }), '发给琳的消息');
    await page.screenshot({ path: resolve(output, 'actual-zoom-200.png') });
  }
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

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    const { initReader } = await import('/embedpdf.js');
    const original = await (await fetch('/fixture.pdf')).arrayBuffer();
    const host = { session: () => ({ status: 'anonymous' }), subscribeSession: () => () => {},
      login: async () => {}, restore: () => undefined, save: () => {},
      send: async () => { throw Error('Unexpected model invocation'); }, stop: async () => {} };
    window.openAnnotationProbe = async ({ useExport = false, edits = [] } = {}) => {
      window.annotationReader?.destroy();
      window.annotationProbe = { edits: [], errors: 0 };
      const documentId = crypto.randomUUID();
      let ready;
      const loaded = new Promise(resolve => { ready = resolve; });
      window.annotationReader = await initReader({ target: document.getElementById('viewer'), documentId, title: 'edits.pdf',
        buffer: (useExport ? window.annotationCopy : original).slice(0),
        wasmUrl: new URL('/pdfium.wasm', location.href).href, host, locale: 'zh-CN',
        onOpenFile: () => {}, onClose: () => {}, onReady: () => ready(), onViewChange: () => {},
        annotations: { edits, onEdit: edit => window.annotationProbe.edits.push(structuredClone(edit)),
          onRestoreError: () => { window.annotationProbe.errors++; } } });
      const registry = await document.querySelector('embedpdf-container').registry;
      window.annotationScope = registry.getPlugin('annotation').provides().forDocument(documentId);
      window.exportScope = registry.getPlugin('export').provides().forDocument(documentId);
      await loaded;
    };
    await window.openAnnotationProbe();
  });
  await page.getByRole('button', { name: '批注', exact: true }).last().click();
  await page.getByRole('button', { name: '自由绘制', exact: true }).click();
  // The first fit-to-page reflows the stroke handlers after the native layout settles.
  await page.waitForTimeout(500);
  await page.mouse.move(560, 380);
  await page.mouse.down();
  await page.mouse.move(640, 435, { steps: 12 });
  await page.mouse.move(700, 395, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => window.annotationProbe.edits.length === 1).catch(async error => {
    const diagnostics = await page.evaluate(() => ({ events: window.annotationProbe.edits.length,
      active: window.annotationScope.getActiveTool()?.id,
      annotations: window.annotationScope.getAnnotations().map(entry => ({ type: entry.object.type, commit: entry.commitState })) }));
    throw new Error(`Ink commit was not observed: ${JSON.stringify(diagnostics)}`, { cause: error });
  });
  const inkEdit = await page.evaluate(() => window.annotationProbe.edits[0]);
  assert.equal(inkEdit.pageIndex, 0);
  assert.equal(typeof inkEdit.anchor, 'string');
  assert.equal(inkEdit.item.annotation.inkList.length, 1);
  await page.evaluate(async edits => {
    window.annotationCopy = await window.exportScope.saveAsCopy().toPromise();
    await window.openAnnotationProbe({ edits });
  }, [inkEdit]);
  const inkRestored = () => {
    const annotations = window.annotationScope.getAnnotations({ pageIndex: 0 });
    return annotations.length === 1 && annotations[0].object.inkList?.length === 1 &&
      !window.annotationScope.getState().hasPendingChanges;
  };
  await page.waitForFunction(inkRestored);
  assert.deepEqual(await page.evaluate(() => window.annotationProbe), { edits: [], errors: 0 });
  // Opening the exported bytes exercises the existing native PDF save path.
  await page.evaluate(() => window.openAnnotationProbe({ useExport: true }));
  await page.waitForFunction(inkRestored);
  await page.evaluate(() => {
    const [ink] = window.annotationScope.getAnnotations({ pageIndex: 0 });
    window.annotationScope.deleteAnnotation(0, ink.object.id);
  });
  await page.waitForFunction(() => window.annotationProbe.edits.length === 1);
  const originalDeletion = await page.evaluate(() => window.annotationProbe.edits[0]);
  assert.deepEqual(originalDeletion, { pageIndex: 0, anchor: 0, item: null });
  await page.evaluate(edits => window.openAnnotationProbe({ useExport: true, edits }), [originalDeletion]);
  // Wait for the document's native load and the replayed deletion to settle.
  await page.waitForFunction(() => {
    const state = window.annotationScope.getState();
    return state.pages[0] && state.pages[0].length === 0 && !state.hasPendingChanges;
  });
  assert.deepEqual(await page.evaluate(() => window.annotationProbe), { edits: [], errors: 0 });
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ pdfPages: 3, sends: 1, textExtracted: true,
    correctedVoiceTranscriptUsesHostCommit: true, lostCleanupAckKeepsVisibleDraft: true, collapsePreservesDraftAndRun: true,
    exactLessonResumeSource: true, staleLessonResultIgnored: true, branchAnswerKeepsMainlineResume: true,
    accessibilityTree: { lesson: true, messageInput: true, narrationControl: true },
    lessonCopy: { selected: selection.shadow || selection.document, keyboardEvent: copy.event, clipboardReadback: copy.clipboardReadback || null }, layouts, zoom200,
    unreadCitationRejected: true, mobileClose: true,
    loadingBlocksHostSend: true, loadedToolsReady: true, scannedPagesEmpty: true,
    inlineAndDisplayMath: true, nativeInkRestored: true, embeddedDeletionRestored: true, exportReopensWithInk: true, pageErrors: errors }, null, 2));
  console.log('Native viewer PDF/plugin browser smoke passed.');
} finally {
  await page.screenshot({ path: resolve(output, 'last-state.png') }).catch(() => {});
  await writeFile(resolve(output, 'browser-errors.json'), JSON.stringify(errors));
  await browser.close();
  server.close();
}
