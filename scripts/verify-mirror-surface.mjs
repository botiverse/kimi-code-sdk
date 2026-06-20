// Contract test: verify the repackaged @botiverse/kimi-code-sdk dist exposes
// the Botiverse mirror-side surface additions (LocalKaos + Kaos type) without
// regressing the upstream-bundled API.
//
// Run AFTER `node scripts/repackage-sdk.mjs <src> <out>` against <out>.
// Usage: node scripts/verify-mirror-surface.mjs <repackaged-out-dir>
//
// Background: tygg/Hao 2026-06-20 #proj-runtime:96f626f3 — daemon Kimi-SDK
// driver needs `import { LocalKaos } from '@botiverse/kimi-code-sdk'` so it
// can inject per-agent CLI wrapper PATH via `LocalKaos.create().withEnv(...)`.
// Upstream `node-sdk/src/index.ts` does not re-export LocalKaos / Kaos; the
// Botiverse repackage script extends the dist's export surface in place.
// This verifier ensures the extension actually shipped in the published
// dist and survives any future upstream bundle layout change.
//
// The verifier runs against the PUBLISHED-shape directory (not the source
// tree), so it catches the same bytes consumers will install.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const [, , outArg] = process.argv;
if (!outArg) {
  console.error('usage: verify-mirror-surface.mjs <repackaged-out-dir>');
  process.exit(1);
}
const outDir = resolve(outArg);
const distDir = join(outDir, 'dist');
const mjsPath = join(distDir, 'index.mjs');
const dmtsPath = join(distDir, 'index.d.mts');
const pkgPath = join(outDir, 'package.json');

if (!existsSync(mjsPath) || !existsSync(dmtsPath) || !existsSync(pkgPath)) {
  console.error(`verify: expected ${mjsPath}, ${dmtsPath}, ${pkgPath}`);
  process.exit(1);
}

const failures = [];
function expect(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
console.log(`verify: ${pkg.name}@${pkg.version}`);

// 1. Source-level inspection — the repackage script should have edited
//    dist/index.mjs's trailing export block to include LocalKaos.
const mjs = readFileSync(mjsPath, 'utf8');
expect(
  'dist/index.mjs trailing export includes LocalKaos',
  /^export \{[^}]*\bLocalKaos\b[^}]*\};?\s*$/m.test(mjs),
);
expect(
  'dist/index.mjs still bundles LocalKaos implementation',
  /var LocalKaos = class LocalKaos\b/.test(mjs),
);
// Sanity: the entries that were already exported upstream should still be there.
for (const name of ['KimiHarness', 'Session', 'createKimiHarness', 'KimiError']) {
  expect(
    `dist/index.mjs still exports ${name}`,
    new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\};?\\s*$`, 'm').test(mjs),
  );
}

// 2. Type-level inspection — d.mts should re-export LocalKaos and Kaos type.
const dmts = readFileSync(dmtsPath, 'utf8');
expect(
  'dist/index.d.mts has `export { LocalKaos };` (mirror surface)',
  /\bexport\s*\{\s*LocalKaos\s*\}\s*;/.test(dmts),
);
expect(
  'dist/index.d.mts has `export type { Kaos };` (mirror surface)',
  /\bexport type\s*\{\s*Kaos\s*\}\s*;/.test(dmts),
);
expect(
  'dist/index.d.mts still declares Kaos interface',
  /declare interface Kaos\b/.test(dmts),
);

// 3. Runtime import — actually load the dist as a module and assert the symbol.
//    Use a dynamic import via file URL so the mirror dist is exercised exactly
//    as a published consumer would.
//    NOTE: this section requires the dist's runtime peer deps (`@antfu/utils`,
//    `smol-toml`, `yazl`, `zod`) to be installed in a node_modules visible to
//    the dist file. The publish-sdk workflow runs `npm install --omit=dev`
//    against the repackaged out-dir before invoking this verifier; in that
//    context the runtime checks are mandatory. When verifying against an
//    extracted bare tarball without an install, source-level checks above are
//    sufficient and the runtime block soft-skips.
const runtimeDepsAvailable = existsSync(join(outDir, 'node_modules'));
if (runtimeDepsAvailable) {
  let mod;
  try {
    mod = await import(pathToFileURL(mjsPath).href);
  } catch (err) {
    expect('dist is importable (peer deps resolved)', false, err instanceof Error ? err.message : String(err));
  }
  if (mod) {
    expect(
      '`import { LocalKaos } from <dist>` resolves to a class',
      typeof mod.LocalKaos === 'function',
      `typeof LocalKaos = ${typeof mod.LocalKaos}`,
    );
    if (typeof mod.LocalKaos === 'function') {
      expect(
        'LocalKaos.create exists as static factory',
        typeof mod.LocalKaos.create === 'function',
        `typeof LocalKaos.create = ${typeof mod.LocalKaos.create}`,
      );
      try {
        const kaos = await mod.LocalKaos.create();
        expect(
          'LocalKaos.create() returns object with withEnv method',
          kaos !== null && typeof kaos === 'object' && typeof kaos.withEnv === 'function',
        );
        if (kaos !== null && typeof kaos.withEnv === 'function') {
          const overlaid = kaos.withEnv({ PATH: '/tmp/test-mirror-surface' });
          expect(
            'LocalKaos.withEnv returns object with same shape (chainable)',
            overlaid !== null && typeof overlaid === 'object' && typeof overlaid.withEnv === 'function',
          );
        }
      } catch (err) {
        expect('LocalKaos.create() runs without throwing', false, err instanceof Error ? err.message : String(err));
      }
    }
  }
} else {
  console.log('  skip runtime import checks (no node_modules in out-dir; install peer deps to enable)');
}

if (failures.length === 0) {
  console.log(`verify: PASS (${pkg.name}@${pkg.version} surface contract holds)`);
  process.exit(0);
}
console.error(`verify: FAIL (${failures.length} failure${failures.length === 1 ? '' : 's'})`);
process.exit(1);
