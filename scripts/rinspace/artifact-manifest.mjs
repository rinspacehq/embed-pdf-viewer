import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve(process.argv[2]);
const sourceCommit = process.env.SOURCE_COMMIT;
if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new Error('Exact source commit is required');
const archives = (await readdir(directory)).filter(name => name.endsWith('.tgz'));
if (archives.length !== 1) throw new Error('Expected one tested snippet archive');
const bytes = await readFile(resolve(directory, archives[0]));
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1,
  repository: 'rinspacehq/embed-pdf-viewer', sourceCommit,
  upstreamCommit: 'dfb2df818065c704a0241beb0791e2fd0d55a10e', artifact: archives[0],
  sha256: createHash('sha256').update(bytes).digest('hex'),
  integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  checks: ['snippet-build', 'bundled-license-coverage', 'native-pdf-plugin-browser'],
}, null, 2) + '\n');
