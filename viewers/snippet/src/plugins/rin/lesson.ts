// SPDX-License-Identifier: MIT
import DOMPurify from 'dompurify';
import type { RinRenderedLesson } from './types';

const blockID = /^[a-z][a-z0-9-]{0,63}$/;
const digest = /^[0-9a-f]{64}$/;
const fontURL = /^\/fonts\/mathjax-newcm\/woff2\/[a-z0-9-]+\.woff2$/;
const layout = `
:host{display:block;min-width:0;contain:layout paint;isolation:isolate;color:inherit;font:inherit}
.lesson{line-height:1.7;overflow-wrap:anywhere;user-select:text}.lesson:focus{outline:none}
.lesson>div{margin-block:0 1rem}.lesson p{margin-block:.45em}
.lesson h1,.lesson h2,.lesson h3,.lesson h4{font-weight:600;line-height:1.4;margin-block:1em .5em}
.lesson h1{font-size:1.35em}.lesson h2{font-size:1.2em}.lesson h3{font-size:1.1em}
.lesson a{color:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.lesson pre,.lesson table{display:block;max-width:100%;overflow:auto}
.lesson mjx-container[display],.lesson .rin-math-display{max-width:100%;overflow-x:auto;overflow-y:hidden}
`;

// Styles stay in the lesson's shadow root. Only reviewed local MathJax font
// declarations may enter the owning document (also copied by native PiP).
function mathStyles(owner: Document, source: string): { css: string; fonts: string[] } {
  const Sheet = owner.defaultView?.CSSStyleSheet;
  if (!Sheet) throw new Error('数学排版暂不可用。');
  const sheet = new Sheet();
  sheet.replaceSync(source);
  const fonts: string[] = [];
  const inspect = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule.type === 3 || rule.type === 10) throw new Error('无效的排版资源。'); // import / namespace
      if (rule.type === 5) fonts.push(rule.cssText);
      for (const match of rule.cssText.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) {
        if (rule.type !== 5 || !fontURL.test(match[1])) throw new Error('无效的排版资源。');
      }
      if ('cssRules' in rule) inspect((rule as CSSGroupingRule).cssRules);
    }
  };
  inspect(sheet.cssRules);
  return { css: Array.from(sheet.cssRules).map(rule => rule.cssText).join('\n'), fonts };
}

/** Render final HTML only: no client Typst compiler and no Markdown fallback.
 * The server validates the Renderer profile and bundle; this boundary also
 * verifies stored bytes and sanitizes browser content before DOM insertion.
 */
export async function mountRinLesson(target: HTMLElement, lesson: RinRenderedLesson, signal: AbortSignal): Promise<void> {
  const owner = target.ownerDocument;
  if (lesson.view?.schema !== 'reader-lesson-view/v1' || !Number.isSafeInteger(lesson.revision) || lesson.revision < 2 ||
      !digest.test(lesson.htmlDigest) || !digest.test(lesson.resultHash) || !lesson.html || lesson.view.steps.length < 1 || lesson.view.steps.length > 128) {
    throw new Error('教学内容格式无效。');
  }
  if (!['continue','wait','done'].includes(lesson.view.next)) throw new Error('教学内容格式无效。');
  const bytes = new TextEncoder().encode(lesson.html);
  const stepIDs = new Set<string>();
  const checkIDs = new Set<string>();
  let hasQuestion = false;
  for (const step of lesson.view.steps) {
    if (!step || !blockID.test(step.id) || stepIDs.has(step.id) ||
        !['explanation','example','derivation','question','feedback'].includes(step.kind) ||
        step.parentStepId !== undefined && (!blockID.test(step.parentStepId) || step.parentStepId === step.id) ||
        !Array.isArray(step.evidenceRefs) || step.evidenceRefs.length > 128 || new Set(step.evidenceRefs).size !== step.evidenceRefs.length ||
        step.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.length || ref.length > 128 || ref.includes('\0')) ||
        !Array.isArray(step.narration) || step.narration.length > 16 ||
        step.narration.some(part => typeof part !== 'string' || !part.trim() || Array.from(part).length > 160 || part.includes('\0')) ||
        step.checkId !== undefined && (!blockID.test(step.checkId) || step.kind !== 'question' || checkIDs.has(step.checkId))) {
      throw new Error('教学步骤格式无效。');
    }
    stepIDs.add(step.id);
    if (step.checkId) checkIDs.add(step.checkId);
    hasQuestion ||= step.kind === 'question';
  }
  if (lesson.view.next === 'wait' && !hasQuestion) throw new Error('教学步骤格式无效。');
  const assessment = lesson.view.assessment;
  if (assessment && (!blockID.test(assessment.checkId) || !['correct','partially-correct','incorrect','uncertain'].includes(assessment.verdict) || assessment.basis !== 'model' || typeof assessment.assisted !== 'boolean')) throw new Error('评价格式无效。');
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('教学内容过大。');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  signal.throwIfAborted();
  if (hash !== lesson.htmlDigest) throw new Error('教学内容校验失败，请重新加载。');
  const template = owner.createElement('template');
  template.innerHTML = lesson.html;
  const styles = Array.from(template.content.querySelectorAll('style'));
  if (styles.length > 1 || styles.some(style => style.parentNode !== template.content || style.className !== 'rin-mathjax-chtml-style' ||
      style.getAttribute('data-rin-math-engine') !== 'mathjax-chtml')) throw new Error('教学排版格式无效。');
  const math = mathStyles(owner, styles[0]?.textContent || '');
  styles.forEach(style => style.remove());
  if (template.content.querySelector('script,iframe,object,embed,link,base,meta,form,input,button,img,svg,audio,video')) throw new Error('教学内容包含不支持的元素。');
  for (const element of Array.from(template.content.querySelectorAll('*'))) {
    for (const attr of Array.from(element.attributes)) {
      if (/^on/i.test(attr.name) || attr.name === 'style' && /url\s*\(|expression\s*\(/i.test(attr.value)) throw new Error('教学内容包含无效属性。');
    }
    const href = element.getAttribute('href');
    if (href && !href.startsWith('#')) {
      const url = new URL(href, owner.baseURI);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('教学链接无效。');
    }
  }
  const safe = DOMPurify.sanitize(template.innerHTML, {
    USE_PROFILES: { html: true, mathMl: true },
    ADD_ATTR: ['style', 'unselectable', 'space', 'rspace', 'size', 'jax', 'overflow', 'justify'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link', 'base', 'meta', 'form', 'input', 'button', 'img', 'svg', 'audio', 'video'],
    CUSTOM_ELEMENT_HANDLING: { tagNameCheck: /^mjx-[a-z0-9-]+$/, attributeNameCheck: /^[a-z][a-z0-9-]*$/, allowCustomizedBuiltInElements: false },
  });
  template.innerHTML = safe;
  const ids = new Set<string>();
  for (const element of Array.from(template.content.querySelectorAll('[id]'))) {
    if (ids.has(element.id)) throw new Error('教学锚点重复。');
    ids.add(element.id);
  }
  const roots = Array.from(template.content.children);
  if (roots.length !== lesson.view.steps.length || roots.some((root, index) => root.tagName !== 'DIV' ||
      !blockID.test(lesson.view.steps[index].id) || root.id !== `fragment-${lesson.view.steps[index].id}`)) throw new Error('教学步骤与排版不匹配。');
  signal.throwIfAborted();
  const shadow = target.shadowRoot || target.attachShadow({ mode: 'open' });
  const style = owner.createElement('style');
  style.textContent = layout + math.css;
  const body = owner.createElement('div');
  body.className = 'lesson';
  body.tabIndex = -1;
  body.append(template.content);
  const lessonSelection = () => (shadow as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() || owner.getSelection();
  body.addEventListener('pointerup', () => {
    if (lessonSelection()?.toString().trim()) body.focus({ preventScroll: true });
  });
  body.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && lessonSelection()?.toString()) {
      // Keep EmbedPDF's global PDF-selection shortcut from replacing the
      // selected lesson text. Do not preventDefault: the browser owns copy.
      event.stopPropagation();
    }
  }, { capture: true });
  body.addEventListener('click', event => {
    const anchor = (event.target as Element).closest('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href')!;
    if (href.startsWith('#')) {
      event.preventDefault();
      try { shadow.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'nearest' }); } catch { /* Invalid local anchor. */ }
    } else {
      event.preventDefault();
      owner.defaultView?.open(href, '_blank', 'noopener,noreferrer');
    }
  });
  // The executing module retains its original Window realm when the mounted
  // panel moves into PiP. Register new font subsets in both documents so a
  // lesson produced while popped out remains complete after returning.
  for (const fontDocument of new Set([owner, document])) {
    if (!math.fonts.length) continue;
    let fonts = fontDocument.head.querySelector<HTMLStyleElement>('style[data-rin-lesson-fonts]');
    if (!fonts) {
      fonts = fontDocument.createElement('style');
      fonts.dataset.rinLessonFonts = 'mathjax-newcm/v1';
      fontDocument.head.append(fonts);
    }
    const existing = fonts.textContent || '';
    const missing = math.fonts.filter(rule => !existing.includes(rule));
    if (missing.length) fonts.textContent = existing + '\n' + missing.join('\n');
  }
  shadow.replaceChildren(style, body);
}
