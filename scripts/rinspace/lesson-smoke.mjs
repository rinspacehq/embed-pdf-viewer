// Real Chromium + actual Renderer final-output fixture. No model/user content.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../viewers/snippet/package.json', import.meta.url));
const ts = require('typescript');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const output = process.env.READER_EVIDENCE_DIR;
const fixture = process.env.READER_FRAGMENT_FIXTURE;
const fonts = process.env.READER_MATH_FONT_ROOT;
if (!output || !fixture || !fonts) throw new Error('Set external READER_EVIDENCE_DIR, READER_FRAGMENT_FIXTURE and READER_MATH_FONT_ROOT');
await mkdir(output, { recursive: true });
const source = await readFile(new URL('../../viewers/snippet/src/plugins/rin/lesson.ts', import.meta.url), 'utf8');
const module = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace("from 'dompurify'", "from '/purify.mjs'");
const purify = await readFile(join(dirname(require.resolve('dompurify')), 'purify.es.mjs'));
const bundle = JSON.parse(await readFile(fixture, 'utf8'));
const html = bundle.inline.pages[0].fragment;
const requests = [];
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  requests.push(path);
  if (path === '/lesson.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(module); return; }
  if (path === '/purify.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(purify); return; }
  if (path.startsWith('/fonts/mathjax-newcm/woff2/')) {
    const file = resolve(fonts, path.split('/').pop());
    if (!file.startsWith(resolve(fonts) + sep)) { response.writeHead(403).end(); return; }
    try { response.setHeader('Content-Type', 'font/woff2'); response.end(await readFile(file)); } catch { response.writeHead(404).end(); }
    return;
  }
  if (path === '/favicon.ico') { response.writeHead(204).end(); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><head><style>body{margin:0;background:rgb(248,248,248);font:14px sans-serif}#outside{color:rgb(7,8,9)}#lesson{display:block;width:340px;margin:12px}</style></head><body><div id="outside">Outside unchanged</div><div id="lesson"></div></body></html>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const result = { schema: 'reader-lesson-browser/v1', browser: browser.version(), scope: 'Actual producer HTML/MathJax; browser lesson module, no model or product API', checks: {} };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  result.checks.render = await page.evaluate(async ({ html, resultHash }) => {
    const { mountRinLesson } = await import('/lesson.mjs');
    const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
    const target = document.querySelector('#lesson');
    const lesson = { operationId: '40000000-0000-4000-8000-000000000001', revision: 2, resultHash, html, htmlDigest: await digest(html),
      view: { schema: 'reader-lesson-view/v1', steps: ['first', 'second'].map(id => ({ id, kind: 'explanation', evidenceRefs: [], narration: [] })), next: 'done' } };
    window.probe = { mountRinLesson, lesson, digest, target };
    await mountRinLesson(target, lesson, new AbortController().signal);
    await document.fonts.ready;
    const root = target.shadowRoot;
    let anchorScrolled = '';
    root.getElementById('eq-later').scrollIntoView = () => { anchorScrolled = 'eq-later'; };
    root.querySelector('a[href="#eq-later"]').click();
    return { formulas: root.querySelectorAll('mjx-container').length, mathML: root.querySelectorAll('mjx-assistive-mml math').length,
      fragmentRoots: root.querySelectorAll('.lesson>div').length, customGlyphs: root.querySelectorAll('mjx-c').length,
      outsideColor: getComputedStyle(document.querySelector('#outside')).color, anchorScrolled,
      globalMathStyles: document.head.querySelectorAll('style.rin-mathjax-chtml-style').length,
      fontStyles: document.head.querySelectorAll('style[data-rin-lesson-fonts]').length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  }, { html, resultHash: bundle.resultHash });
  assert.equal(result.checks.render.formulas, 2);
  assert.equal(result.checks.render.mathML, 2);
  assert.equal(result.checks.render.fragmentRoots, 2);
  assert.ok(result.checks.render.customGlyphs > 0);
  assert.equal(result.checks.render.outsideColor, 'rgb(7, 8, 9)');
  assert.equal(result.checks.render.anchorScrolled, 'eq-later');
  assert.equal(result.checks.render.globalMathStyles, 0);
  assert.equal(result.checks.render.fontStyles, 1);
  assert.equal(result.checks.render.horizontalOverflow, false);
  result.checks.assessment = await page.evaluate(async () => {
    const { lesson, target, mountRinLesson } = window.probe;
    const partial = { ...lesson, view: { ...lesson.view, assessment: { checkId: 'check-one', verdict: 'partially-correct', basis: 'model', assisted: false } } };
    await mountRinLesson(target, partial, new AbortController().signal);
    let unknownRejected = false;
    try {
      await mountRinLesson(target, { ...partial, view: { ...partial.view, assessment: { ...partial.view.assessment, verdict: 'mastered' } } }, new AbortController().signal);
    } catch { unknownRejected = true; }
    await mountRinLesson(target, lesson, new AbortController().signal);
    return { partialAccepted: target.shadowRoot.querySelectorAll('mjx-container').length === 2, unknownRejected };
  });
  assert.deepEqual(result.checks.assessment, { partialAccepted: true, unknownRejected: true });
  result.checks.reject = await page.evaluate(async () => {
    const { lesson, digest, target, mountRinLesson } = window.probe;
    const rejected = [];
    for (const [name, body] of [
      ['script', lesson.html.replace('<div id="fragment-first">', '<div id="fragment-first"><script>window.pwned=1</script>')],
      ['remote-image', lesson.html.replace('<div id="fragment-first">', '<div id="fragment-first"><img src="https://untrusted.invalid/pixel">')],
      ['remote-font', lesson.html.replace('/fonts/mathjax-newcm/woff2/mjx-ncm-n.woff2', 'https://untrusted.invalid/font.woff2')],
      ['duplicate-anchor', lesson.html.replace('id="eq-later"', 'id="eq-first"')],
      ['wrong-step', lesson.html.replace('id="fragment-second"', 'id="fragment-foreign"')],
    ]) {
      try { await mountRinLesson(target, { ...lesson, html: body, htmlDigest: await digest(body) }, new AbortController().signal); }
      catch { rejected.push(name); }
    }
    for (const [name, view] of [
      ['duplicate-step-metadata', { ...lesson.view, steps: [lesson.view.steps[0], lesson.view.steps[0]] }],
      ['invalid-narration', { ...lesson.view, steps: [{ ...lesson.view.steps[0], narration: [''] }, lesson.view.steps[1]] }],
      ['self-parent', { ...lesson.view, steps: [{ ...lesson.view.steps[0], parentStepId: lesson.view.steps[0].id }, lesson.view.steps[1]] }],
      ['check-on-explanation', { ...lesson.view, steps: [{ ...lesson.view.steps[0], checkId: 'check-one' }, lesson.view.steps[1]] }],
      ['wait-without-question', { ...lesson.view, next: 'wait' }],
      ['unknown-next', { ...lesson.view, next: 'later' }],
    ]) {
      try { await mountRinLesson(target, { ...lesson, view }, new AbortController().signal); }
      catch { rejected.push(name); }
    }
    try { await mountRinLesson(target, { ...lesson, htmlDigest: '0'.repeat(64) }, new AbortController().signal); } catch { rejected.push('digest'); }
    const controller = new AbortController(); controller.abort();
    try { await mountRinLesson(target, lesson, controller.signal); } catch { rejected.push('aborted'); }
    return { rejected, intact: target.shadowRoot.querySelectorAll('mjx-container').length === 2, executed: Boolean(window.pwned) };
  });
  assert.deepEqual(result.checks.reject.rejected, ['script', 'remote-image', 'remote-font', 'duplicate-anchor', 'wrong-step', 'duplicate-step-metadata', 'invalid-narration', 'self-parent', 'check-on-explanation', 'wait-without-question', 'unknown-next', 'digest', 'aborted']);
  assert.equal(result.checks.reject.intact, true);
  assert.equal(result.checks.reject.executed, false);
  assert.equal(requests.some(path => path.includes('untrusted')), false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(output, 'lesson-mobile.png'), fullPage: true });
  result.requests = requests;
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
