// Tests the exact lesson/playback identity rule without a browser or user data.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../viewers/snippet/package.json', import.meta.url));
const ts = require('typescript');
const temporary = await mkdtemp(join(tmpdir(), 'embedpdf-narration-test-'));
const modulePath = join(temporary, 'narration.mjs');
const source = await readFile(new URL('../../viewers/snippet/src/plugins/rin/narration.ts', import.meta.url), 'utf8');
await writeFile(modulePath, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { narrationMatchesLesson } = await import(pathToFileURL(modulePath).href);
after(() => rm(temporary, { recursive: true, force: true }));

const operationId = '71000000-0000-4000-8000-000000000001';
const firstHash = 'a'.repeat(64);

test('narration controls only the exact rendered lesson result', () => {
  const lesson = { operationId, resultHash: firstHash };
  const exact = { operationId, stepId: 'explain', narrationIndex: 0, lessonResultHash: firstHash };
  assert.equal(narrationMatchesLesson(exact, lesson), true);
  assert.equal(narrationMatchesLesson({ ...exact, operationId: '71000000-0000-4000-8000-000000000002' }, lesson), false);
  assert.equal(narrationMatchesLesson({ ...exact, lessonResultHash: 'b'.repeat(64) }, lesson), false);
  assert.equal(narrationMatchesLesson(undefined, lesson), false);
});
