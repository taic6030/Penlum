import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { restoreSQL } from '../packages/domain/src/restore';
const input = process.argv[2];
if (!input) throw new Error('Usage: pnpm backup:restore <export.json> [--apply-local]');
const raw = JSON.parse(await readFile(resolve(input), 'utf8'));
const statements = restoreSQL(raw.data || raw);
await mkdir('.wrangler', { recursive: true });
const output = resolve('.wrangler/restore.sql');
await writeFile(output, statements.join('\n'), { mode: 0o600 });
console.log(
  `Restore SQL ready: ${output}. Existing sites are never overwritten. Restore media bytes separately using the manifest.`,
);
if (process.argv.includes('--apply-local'))
  execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'penlum-local',
      '--local',
      '--env=',
      '--file',
      output,
    ],
    { stdio: 'inherit' },
  );
