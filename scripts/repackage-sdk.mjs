// Repackage the upstream node-sdk (built) into a publishable @botiverse/kimi-code-sdk.
// Run AFTER `pnpm --filter @moonshot-ai/kimi-code-sdk build` in an upstream checkout.
// Usage: node repackage-sdk.mjs <upstream-node-sdk-dir> <out-dir> [kimi-release-tag]
// Produces <out-dir> = a publishable npm package: dist/ + renamed package.json + LICENSE + NOTICE + README.
import { readFileSync, writeFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [, , srcDir, outDir, kimiTag] = process.argv;
if (!srcDir || !outDir) { console.error('usage: repackage-sdk.mjs <src node-sdk dir> <out dir> [kimi tag]'); process.exit(1); }

const pkg = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'));
const upstreamName = pkg.name;                 // @moonshot-ai/kimi-code-sdk
const version = pkg.version;                    // SDK's own version, e.g. 0.9.3

// Rebrand identity; keep upstream's runtime deps + bin/exports untouched (dist is bundled).
pkg.name = '@botiverse/kimi-code-sdk';
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
