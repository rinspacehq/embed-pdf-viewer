// SPDX-License-Identifier: MIT
import DOMPurify from 'dompurify';
import katex from 'katex';
import { Marked, type Tokens } from 'marked';

const tags = ['a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'];
const mathTags = ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace',
  'mfrac', 'msqrt', 'mroot', 'msup', 'msub', 'msubsup', 'munder', 'mover', 'munderover',
  'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'mphantom', 'menclose', 'mmultiscripts', 'ms'];
const mathAttributes = ['display', 'displaystyle', 'scriptlevel', 'encoding', 'mathvariant', 'mathsize',
  'stretchy', 'fence', 'separator', 'form', 'accent', 'accentunder', 'symmetric', 'lspace', 'rspace',
  'largeop', 'movablelimits', 'linethickness', 'columnalign', 'columnspacing', 'rowalign', 'rowspacing',
  'width', 'height', 'depth', 'voffset', 'notation', 'minsize', 'maxsize'];
type MathToken = Tokens.Generic & { text: string };

function renderMath(token: Tokens.Generic, displayMode: boolean): string {
  try {
    return katex.renderToString((token as MathToken).text, {
      displayMode, output: 'mathml', trust: false, throwOnError: true, maxExpand: 160, maxSize: 20,
    });
  } catch {
    return token.raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

const markdown = new Marked({
  extensions: [
    {
      name: 'rinDisplayMath',
      level: 'block',
      start: source => source.search(/(?:^|\n) {0,3}(?:\$\$|\\\[)/),
      tokenizer(source) {
        const match = /^ {0,3}\$\$([\s\S]{1,4000}?)\$\$[ \t]*(?:\n|$)/.exec(source)
          ?? /^ {0,3}\\\[([\s\S]{1,4000}?)\\\][ \t]*(?:\n|$)/.exec(source);
        if (match?.[1].trim()) return { type: 'rinDisplayMath', raw: match[0], text: match[1].trim() };
      },
      renderer: token => renderMath(token, true) + '\n',
    },
    {
      name: 'rinInlineMath',
      level: 'inline',
      start: source => source.search(/\$|\\\(/),
      tokenizer(source) {
        const match = /^\$(?![$\s])((?:\\[^\n]|[^$\\\n]){1,2000}?)\$(?![$\d])/.exec(source)
          ?? /^\\\((.{1,2000}?)\\\)/.exec(source);
        if (match?.[1].trim() && !/\s$/.test(match[1])) return { type: 'rinInlineMath', raw: match[0], text: match[1] };
      },
      renderer: token => renderMath(token, false),
    },
  ],
});

/** Model output is untrusted. Keep Markdown formatting without executable HTML or remote images. */
export function renderRinMarkdown(source: string): string {
  const html = markdown.parse(source, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...tags, ...mathTags],
    ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', ...mathAttributes],
    ALLOW_DATA_ATTR: false,
  });
}
