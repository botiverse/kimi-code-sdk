// Repackage the upstream node-sdk (built) into a publishable @botiverse/kimi-code-sdk.
// Run AFTER `pnpm --filter @moonshot-ai/kimi-code-sdk build` in an upstream checkout.
// Usage: node repackage-sdk.mjs <upstream-node-sdk-dir> <out-dir> [kimi-release-tag] [npm-version-override]
//
// `npm-version-override` (4th arg) lets us cut a fresh @botiverse/kimi-code-sdk
// version even when upstream's node-sdk package.json version stayed put.
// Upstream is a private internal package whose semver cadence is theirs;
// our consumer cadence shouldn't be hostage to it. When upstream ships a
// meaningful bundled-implementation refresh (e.g. agent-core / kosong /
// protocol upgrades inlined into dist) without bumping node-sdk version,
// we patch-bump on our side. The mirror-tag → npm-version mapping in
// RELEASES.md is the truth.
//
// Produces <out-dir> = a publishable npm package: dist/ + renamed package.json + LICENSE + NOTICE + README.
//
// Mirror-side surface additions (tygg/Hao 2026-06-20 #proj-runtime:96f626f3): when
// an upstream `kimi-code` release ships a fully-bundled `LocalKaos` / `Kaos`
// implementation but does not re-export them from `node-sdk/src/index.ts`, we
// expose those symbols at the mirror's published top level. Consumers (Slock
// daemon Kimi-SDK driver) need `LocalKaos.create().withEnv({ PATH })` to inject
// per-agent CLI wrapper PATH into Kimi tool execution without daemon-wide env
// pollution. The implementation is already inlined into upstream dist; we only
// extend the published export list.
import { readFileSync, writeFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [, , srcDir, outDir, kimiTag, npmVersionOverride] = process.argv;
if (!srcDir || !outDir) { console.error('usage: repackage-sdk.mjs <src node-sdk dir> <out dir> [kimi tag] [npm-version-override]'); process.exit(1); }

const pkg = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'));
const upstreamName = pkg.name;                  // @moonshot-ai/kimi-code-sdk
const upstreamVersion = pkg.version;            // upstream's own version, e.g. 0.9.3
const version = npmVersionOverride || upstreamVersion;
if (npmVersionOverride && npmVersionOverride !== upstreamVersion) {
  console.log(`note: overriding npm version ${upstreamVersion} -> ${npmVersionOverride}`);
}

// Rebrand identity; keep upstream's runtime deps + bin/exports untouched (dist is bundled).
pkg.name = '@botiverse/kimi-code-sdk';
pkg.version = version;
pkg.description = `Botiverse repackage of ${upstreamName}${kimiTag ? ` (from kimi-code ${kimiTag})` : ''} — built node-sdk bundle for Slock. Mirror of MoonshotAI/kimi-code.`;
pkg.repository = { type: 'git', url: 'git+https://github.com/botiverse/kimi-code-sdk.git' };
pkg.homepage = 'https://github.com/botiverse/kimi-code-sdk#readme';
pkg.bugs = { url: 'https://github.com/botiverse/kimi-code-sdk/issues' };
pkg.license = pkg.license || 'MIT';
// Make the entry explicit + dist-based (upstream's dev package.json points exports at
// ./src via the workspace; the PUBLISHED package ships only built dist/). Use upstream's
// own publishConfig.exports if present, else the standard dist mapping.
const pubExports = (pkg.publishConfig && pkg.publishConfig.exports)
  || { '.': { types: './dist/index.d.mts', import: './dist/index.mjs', default: './dist/index.mjs' } };
pkg.exports = pubExports;
pkg.main = './dist/index.mjs';
pkg.module = './dist/index.mjs';
pkg.types = './dist/index.d.mts';
pkg.type = pkg.type || 'module';
pkg.publishConfig = { access: 'public', provenance: true };   // OIDC trusted publishing + provenance
delete pkg.private;
delete pkg.devDependencies;                     // siblings are bundled into dist already
delete pkg.scripts;                             // no build needed in the published pkg
pkg.files = Array.from(new Set([...(pkg.files || ['dist']), 'LICENSE', 'NOTICE.md', 'README.md']));
pkg.botiverse = { upstream: upstreamName, kimiRelease: kimiTag || null, source: 'https://github.com/MoonshotAI/kimi-code' };

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(srcDir, 'dist'), join(outDir, 'dist'), { recursive: true });
extendDistKaosSurface(join(outDir, 'dist'));
writeFileSync(join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
// Attribution: upstream LICENSE (MIT) preserved + our NOTICE.
let licCopied = false;
for (const base of [srcDir, join(srcDir, '..', '..')]) {
  for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    if (!licCopied && existsSync(join(base, f))) { cpSync(join(base, f), join(outDir, 'LICENSE')); licCopied = true; }
  }
}
if (!licCopied) console.warn('WARN: no upstream LICENSE found to bundle');
writeFileSync(join(outDir, 'NOTICE.md'),
  `# NOTICE\n\n@botiverse/kimi-code-sdk is a repackage of the built **${upstreamName}** node-sdk\n` +
  `from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)${kimiTag ? ` at \`${kimiTag}\`` : ''}, ` +
  `distributed under upstream's MIT License (see LICENSE). Sibling packages are bundled into \`dist\`.\n` +
  `Mirror + provenance: https://github.com/botiverse/kimi-code-sdk\n`);
writeFileSync(join(outDir, 'README.md'),
  `# @botiverse/kimi-code-sdk\n\nBuilt repackage of \`${upstreamName}\`${kimiTag ? ` (kimi-code ${kimiTag})` : ''} for Slock/Botiverse.\n` +
  `Read-only mirror + release notes: https://github.com/botiverse/kimi-code-sdk\n\n> Not affiliated with Moonshot AI. MIT (see LICENSE).\n`);
console.log(`repackaged ${upstreamName}@${version} -> @botiverse/kimi-code-sdk@${version} at ${outDir}`);

// ── Mirror-side Kaos surface extension ──────────────────────────────────────
//
// Upstream's `node-sdk/dist/index.mjs` bundles `LocalKaos` (along with the rest
// of the kaos package) but does not include it in its trailing `export { ... }`
// statement. Same for `index.d.mts` — the `Kaos` interface is declared but
// never publicly exported. The SDK consumer (Slock daemon's Kimi-SDK driver)
// needs both symbols to inject per-agent CLI wrapper PATH via
// `LocalKaos.create().withEnv({ PATH })` and pass the result through
// `harness.createSession({ kaos })`.
//
// We extend the dist's published export surface in-place: append `LocalKaos`
// to the trailing JS export list and add `export { LocalKaos };` +
// `export type { Kaos };` to the .d.mts. We do not modify or rebundle any
// implementation; the bundled `var LocalKaos = class LocalKaos { ... }` and
// `declare interface Kaos { ... }` already exist in the upstream dist.
//
// Failure mode: if a future upstream dist refactor drops `LocalKaos` from the
// bundle, or splits the export-tail format, the assertions below fail closed
// so the publish-sdk workflow refuses to ship a broken mirror.
function extendDistKaosSurface(distDir) {
  const mjsPath = join(distDir, 'index.mjs');
  const dmtsPath = join(distDir, 'index.d.mts');

  const mjs = readFileSync(mjsPath, 'utf8');
  if (!/var LocalKaos = class LocalKaos\b/.test(mjs)) {
    throw new Error('repackage: upstream dist/index.mjs no longer bundles LocalKaos; refusing to extend surface');
  }
  // Find the trailing top-level `export { ... };` line (last one in file).
  // tsdown emits exactly one trailing brace-list export for the entry module.
  const exportTailRe = /(^export \{[^}]*?)(\s*\}\s*;?\s*)$/m;
  const match = mjs.match(exportTailRe);
  if (!match) {
    throw new Error('repackage: upstream dist/index.mjs has no recognisable trailing `export { ... }` block');
  }
  if (/\bLocalKaos\b/.test(match[1])) {
    throw new Error('repackage: dist already exports LocalKaos; remove this mirror-side patch');
  }
  const extendedMjs = mjs.replace(exportTailRe, `$1, LocalKaos$2`);
  writeFileSync(mjsPath, extendedMjs);

  const dmts = readFileSync(dmtsPath, 'utf8');
  if (!/declare interface Kaos\b/.test(dmts)) {
    throw new Error('repackage: upstream dist/index.d.mts no longer declares Kaos interface');
  }
  if (/\bexport\s*\{\s*LocalKaos\b/.test(dmts) || /\bexport type\s*\{\s*Kaos\b/.test(dmts)) {
    throw new Error('repackage: dist d.mts already exports Kaos surface; remove this mirror-side patch');
  }
  // Upstream's bundled .d.mts declares the `Kaos` interface but tree-shakes the
  // `LocalKaos` class type declaration (the implementation is still bundled in
  // .mjs). Append a minimal class declaration that matches the public surface
  // from `packages/kaos/src/local.ts:157` (`export class LocalKaos implements
  // Kaos { static async create(): Promise<LocalKaos> }`). The class
  // `implements Kaos`, so all interface members are inherited from the
  // already-declared `Kaos` interface. Only `withCwd` / `withEnv` need
  // explicit re-declaration to tighten the return type from `Kaos` to
  // `LocalKaos` (so chained calls preserve the concrete type).
  const extendedDmts = dmts.trimEnd() + `\n\n// Botiverse mirror surface extension — see scripts/repackage-sdk.mjs.\n// Minimal type declaration; runtime implementation is bundled in dist/index.mjs.\ndeclare class LocalKaos implements Kaos {\n  static create(): Promise<LocalKaos>;\n  readonly name: string;\n  readonly osEnv: Kaos['osEnv'];\n  pathClass(): 'posix' | 'win32';\n  normpath(path: string): string;\n  gethome(): string;\n  getcwd(): string;\n  chdir(path: string): Promise<void>;\n  withCwd(cwd: string): LocalKaos;\n  withEnv(env: Record<string, string>): LocalKaos;\n  stat: Kaos['stat'];\n  iterdir: Kaos['iterdir'];\n  glob: Kaos['glob'];\n  readBytes: Kaos['readBytes'];\n  readText: Kaos['readText'];\n  readLines: Kaos['readLines'];\n  writeBytes: Kaos['writeBytes'];\n  writeText: Kaos['writeText'];\n  mkdir: Kaos['mkdir'];\n  exec: Kaos['exec'];\n  execWithEnv: Kaos['execWithEnv'];\n}\nexport { LocalKaos };\nexport type { Kaos };\n`;
  writeFileSync(dmtsPath, extendedDmts);

  console.log('repackage: extended dist with LocalKaos export and Kaos type re-export');
}
