# Mirror release notes

SDK-**interface**-focused release notes for the `@moonshot-ai/kimi-code` mirror tags,
written by the Botiverse maintainer (upstream is private and ships no public release
notes; the upstream app `CHANGELOG.md` covers the CLI/TUI, not the node-sdk interface).

Diff basis: the public surface of `packages/node-sdk` (entry `src/index.ts`) between
consecutive release tags. **Bump the Slock pin only after reading the interface delta below.**

## npm package version mapping

The repackaged dist-only SDK is published to npm as `@botiverse/kimi-code-sdk`. Its version
follows the upstream node-sdk's own internal version (independent of the CLI release tag).
Consumers can pin either by upstream mirror tag (full-monorepo source) or by npm version.

| upstream CLI tag (mirror) | node-sdk version → npm `@botiverse/kimi-code-sdk@` |
| --- | --- |
| `@moonshot-ai/kimi-code@0.15.0` | `0.9.3` (public API unchanged; bundled-implementation refresh — see note) |
| `@moonshot-ai/kimi-code@0.14.3` | `0.9.3` (no SDK change, no new npm publish) |
| `@moonshot-ai/kimi-code@0.14.2` | `0.9.3` (first npm publish, 2026-06-13) |

---

## @moonshot-ai/kimi-code@0.15.0  (← 0.14.3)

**node-sdk public interface: NO change.** node-sdk's `package.json` version stays at `0.9.3`; `src/index.ts` exports unchanged. The single file diff in `packages/node-sdk/` is a test (`session-skills.test.ts`).

**But: the bundled-implementation siblings DID change** — `tsdown` inlines `agent-core`, `kosong`, `kaos`, `oauth`, `protocol` into node-sdk's `dist`, and this upstream release ships notable runtime-side improvements in those packages:

- **`agent-core`**: prompt same-language reasoning (`#787`); refine + polish system prompt context (`#777`, `#780`); decouple agent skill registry (`#784`); resolve model capabilities via static table lookup (`#776`).
- **`agent-core`** fix: close interrupted tool calls on resume (`#768`) — relevant to resume reliability.
- **`agent-core`/`kosong`**: surface skill directory in loaded-skill context block (`#785`).
- **`kosong`** fix: repair mismatched schema types from Xcode 26.5 MCP (`#343`).
- **`agent-core`** feat: MCP support over SSE (`#744`).
- **`update` (CLI-side)**: rolling automatic updates via CDN manifest (`#691`) — only affects the kimi CLI, not the SDK.

**Slock consumer impact:**
- **No public SDK action needed** — `@botiverse/kimi-code-sdk@0.9.3` consumers see no API change.
- npm publishConfig keeps `0.9.3` immutable (correct per npm semantics; you can't overwrite an existing version). The currently-shipped npm tarball was built from upstream `0.14.2` source, so it has the OLDER bundled siblings.
- **Consumers who want the newer bundled-implementation behaviour** (improved system-prompt context, MCP-over-SSE, resume-interrupted-toolcalls fix) should pin to `github:botiverse/kimi-code-sdk#@moonshot-ai/kimi-code@0.15.0` (full monorepo source), OR wait for upstream to bump node-sdk's `package.json` version (which would let us republish a fresh `0.9.4`).
- Slock daemon's `kimi-sdk` driver runs against the npm dist, so until we get a node-sdk version bump from upstream we stay on the 0.14.2-bundled tarball — which IS production-shape (the 0.14.3 → 0.15.0 bundled improvements are nice-to-have, not corrective).

---

## @moonshot-ai/kimi-code@0.14.3  (← 0.14.2)

**node-sdk interface: NO change.** This upstream release is CLI/TUI-only.

- Diff scope: only `apps/kimi-code/` and `docs/` changed; **zero changes to `packages/node-sdk/`** or any of its bundled siblings (`agent-core`, `kosong`, `kaos`, `oauth`, `protocol`, `acp-adapter`, `telemetry`).
- Single feature commit: `feat(kimi-code): refresh OAuth provider models before opening model picker (#713)` — CLI/TUI only.
- node-sdk `package.json` version unchanged at `0.9.3`.

**Slock consumer impact:** **no action needed.** The mirror tag exists for completeness, but consumers pinning `0.9.3` (npm) or `@moonshot-ai/kimi-code@0.14.2` (mirror) can stay — there is no SDK interface delta to react to. No new npm publish: `@botiverse/kimi-code-sdk@0.9.3` already covers this upstream release.

---

## @moonshot-ai/kimi-code@0.14.2  (← 0.14.1)

**node-sdk interface: additive, no breaking change.**
- **NEW** `KimiHarness.getConfigDiagnostics(): Promise<ConfigDiagnostics>` — returns warnings
  from the most recent `config.toml` load (empty when the config is fully valid). New
  `ConfigDiagnostics` type added to the SDK surface (`types.ts` → `index.ts`).
- **Internal (no API change)** `auth.ts` config read/write hardening: write-path base read is
  now strict (so a salvaged base can't silently drop fixable sections on rewrite, with an
  actionable error); read path tolerates a degraded config for token/status resolution.
- Public export surface (`src/index.ts`) **unchanged** — no symbols removed/renamed.

**Slock consumer impact:** safe to bump `0.14.1 → 0.14.2`. Interface is additive only.

**Upstream app/CLI changes (context, not SDK interface):** `--auto`/`--yolo`/`--plan` now
combine with `--session`/`--continue`; iTerm2 endless-notification fix; sub-skills exposed as
dotted slash commands; compaction records shown correctly on resume; foreground Bash
stdout/stderr streamed live; plan-mode resume fix; custom registry sync on startup refresh.
