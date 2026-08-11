// Contract test: verify a Botiverse-variant dist actually carries the roleAdditional
// patch stack — the reason the `botiverse` dist-tag exists at all.
//
// Run AFTER `node scripts/repackage-sdk.mjs <src> <out>` against <out>.
// Usage: node scripts/verify-roleadditional.mjs <repackaged-out-dir>
//
// WHY THIS IS NOT A `grep roleAdditional` CHECK (measured 2026-08-11, Kai):
//   A build made from PLAIN upstream 0.34.0 — i.e. with the patch stack absent —
//   still contains `roleAdditional` in the shipped bytes: 1 occurrence in index.d.mts
//   and 9 in index.mjs (occurrence counts, not `grep -c` line counts -- a line may
//   carry two). Those come from elsewhere in the bundled dependency closure,
//   not from our patch. A presence grep therefore PASSES on an unpatched build:
//   it is a gate that cannot fail in the case it exists to catch.
//   Verified by negative control: the unpatched artifact also passed
//   verify-mirror-surface.mjs (exit 0, 9/9 ok) while carrying no patch at all.
// So we assert PATCH-SPECIFIC symbols that upstream does not emit.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: verify-roleadditional.mjs <repackaged-out-dir>');
  process.exit(2);
}

const dmts = join(outDir, 'dist/index.d.mts');
const mjs = join(outDir, 'dist/index.mjs');
for (const f of [dmts, mjs]) {
  if (!existsSync(f)) {
    console.error(`verify-roleadditional: missing ${f}`);
    process.exit(2);
  }
}
const dts = readFileSync(dmts, 'utf8');
const js = readFileSync(mjs, 'utf8');

const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
console.log(`verify-roleadditional: ${pkg.name}@${pkg.version}`);

// A pure (non-botiverse) build legitimately has no patch stack. Only the
// -botiverse.* variants carry it, so only they are gated here.
if (!/-botiverse\./.test(pkg.version)) {
  console.log('  skip — pure mirror build carries no patch stack by design');
  process.exit(0);
}

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
};

// Patch-specific, upstream does not emit these:
check(/private roleAdditional\??;/.test(dts), 'd.mts declares the private roleAdditional plumbing field');
check(
  /roleAdditional` value that was used to render/.test(dts),
  'd.mts carries the session-API roleAdditional doc surface',
);
// Volume check as a coarse backstop: unpatched measured at 1 (d.mts) / 8 (mjs).
const dtsHits = (dts.match(/roleAdditional/g) || []).length;
const jsHits = (js.match(/roleAdditional/g) || []).length;
check(dtsHits > 5, `d.mts roleAdditional occurrences ${dtsHits} > 5 (unpatched measured 1 occurrence)`);
check(jsHits > 12, `index.mjs roleAdditional occurrences ${jsHits} > 12 (unpatched measured 9 occurrences)`);

if (failures) {
  console.log(`verify-roleadditional: FAIL (${failures} failures)`);
  process.exit(1);
}
console.log(`verify-roleadditional: PASS (${pkg.name}@${pkg.version} carries the roleAdditional patch stack)`);
