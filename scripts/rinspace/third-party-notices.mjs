import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../viewers/snippet');
const bundled = new Set(JSON.parse(await readFile(resolve(root, 'dist/bundled-dependencies.json'), 'utf8')));
const paths = [...bundled].map(name => resolve(root, 'node_modules', name));
let output = '# Third-party notices\n\nBuilt from EmbedPDF v2 dfb2df818065c704a0241beb0791e2fd0d55a10e (MIT).\nOriginal Rin plugin additions are MIT. PDFium and its bundled dependencies are covered by LICENSE.pdfium.\n\n';
const found = new Set();
for (const path of [...new Set(paths)].sort()) {
  const pkg = JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8'));
  if (!bundled.has(pkg.name)) continue;
  found.add(pkg.name);
  output += `## ${pkg.name}@${pkg.version}\n\nDeclared license: ${pkg.license || 'not declared'}\n\n`;
  const names = (await readdir(path)).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  if (!names.length) throw new Error(`License text missing: ${pkg.name}`);
  for (const name of names) output += `### ${name}\n\n${await readFile(resolve(path, name), 'utf8')}\n\n`;
}
for (const name of bundled) if (!found.has(name)) throw new Error(`Bundled license missing: ${name}`);
await writeFile(resolve(root, 'THIRD-PARTY-NOTICES.md'), output);
