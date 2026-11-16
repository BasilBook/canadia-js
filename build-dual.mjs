// Builds one @basilbook package twice (#1687): ES modules to dist/esm and CommonJS to dist/cjs,
// each with its own .d.ts beside it. Run from the package's folder (its `build` script). Each half
// gets a package.json naming its module type, so Node reads dist/esm as ESM whatever the root says.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const cwd = process.cwd();
const tsc = createRequire(join(cwd, 'package.json')).resolve('typescript/bin/tsc');

rmSync(join(cwd, 'dist'), { recursive: true, force: true });
for (const [config, dir, type] of [
  ['tsconfig.esm.json', 'esm', 'module'],
  ['tsconfig.cjs.json', 'cjs', 'commonjs'],
]) {
  execFileSync(process.execPath, [tsc, '-p', config], { cwd, stdio: 'inherit' });
  mkdirSync(join(cwd, 'dist', dir), { recursive: true });
  writeFileSync(join(cwd, 'dist', dir, 'package.json'), `${JSON.stringify({ type })}\n`);
}
