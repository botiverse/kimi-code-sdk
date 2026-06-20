# Mirror release notes

SDK-**interface**-focused release notes for the `@moonshot-ai/kimi-code` mirror tags,
written by the Botiverse maintainer (upstream is private and ships no public release
notes; the upstream app `CHANGELOG.md` covers the CLI/TUI, not the node-sdk interface).

Diff basis: the public surface of `packages/node-sdk` (entry `src/index.ts`) between
consecutive release tags. **Bump the Slock pin only after reading the interface delta below.**

## npm package version mapping

The repackaged dist-only SDK is published to npm as `@botiverse/kimi-code-sdk`. **Its version aligns with the upstream Kimi Code CLI release tag** — when upstream cuts `@moonshot-ai/kimi-code@X.Y.Z`, we publish `@botiverse/kimi-code-sdk@X.Y.Z`.

| upstream CLI tag (mirror) | npm `@botiverse/kimi-code-sdk@` |
| --- | --- |
| `@moonshot-ai/kimi-code@0.18.0` | `0.18.0-botiverse.0` (current; published 2026-06-20; **mirror-side surface extension** — `LocalKaos` + `Kaos` type re-export) |
| `@moonshot-ai/kimi-code@0.18.0` | `0.18.0` (published 2026-06-19; pre-extension) |
| `@moonshot-ai/kimi-code@0.17.1` | `0.17.1` (published 2026-06-18) |
| `@moonshot-ai/kimi-code@0.17.0` | `0.17.0` (published 2026-06-18) |
| `@moonshot-ai/kimi-code@0.16.0` | `0.16.0` (published 2026-06-17) |
| `@moonshot-ai/kimi-code@0.15.0` | `0.15.0` (published 2026-06-16) |
| `@moonshot-ai/kimi-code@0.14.3` | _(no separate publish)_ |
| `@moonshot-ai/kimi-code@0.14.2` | `0.9.3` (legacy — first npm publish, internal node-sdk version; superseded by `0.15.0`) |
| _(internal patch-bump experiment)_ | `0.9.4` (legacy — superseded by `0.15.0`) |

**Versioning policy (revised 2026-06-20, tygg #proj-runtime:96f626f3 msg=7db90df7):** mirror-side changes that extend the published surface beyond what upstream `node-sdk/src/index.ts` exposes carry a `-botiverse.<n>` pre-release suffix on top of the upstream tag. Rule:
- **Pure repackage** (no surface change beyond `node-sdk/src/index.ts`): mirror version = upstream CLI tag verbatim. Established in the original 2026-06-16 lock (tygg msgs=cb736b39 / 9cfb4824 / c1f01b13).
- **Mirror-side surface extension** (e.g. re-exporting symbols upstream did not export, like `LocalKaos`): mirror version = `<upstream-tag>-botiverse.<n>` so `npm install @botiverse/kimi-code-sdk` defaults to the pure mirror, and consumers must explicitly pin to the extended version (`@0.18.0-botiverse.0`) when they need the additional surface. This makes the mirror-side change visible in version metadata rather than silently shipping a different shape under the upstream tag's name.
- Upstream doesn't release → **we don't publish a pure repackage**. We may still publish a `-botiverse.<n>` pre-release against the most recent upstream tag if a mirror-side surface extension is needed.

Rationale: 1:1 alignment with the upstream tag is preserved as the default install target so consumers reading the upstream Kimi Code release notes get exactly the upstream-shape mirror. Mirror-side surface additions are deliberate Botiverse-side changes that should not pretend to be upstream — the pre-release suffix surfaces that distinction. Earlier `0.9.3` and `0.9.4` (which followed the internal node-sdk version) are deprecated on npm in favor of `0.15.0`. The `repackage-sdk.mjs` script's `npm-version-override` arg is the mechanism for the suffix: pass `0.18.0-botiverse.0` when cutting an extended release.

---

## @botiverse/kimi-code-sdk@0.18.0-botiverse.0  (mirror-side surface extension on top of upstream `@moonshot-ai/kimi-code@0.18.0`)

**Mirror-side change only — upstream node-sdk surface unchanged.** The repackaged dist now re-exports `LocalKaos` (runtime) and `Kaos` (TypeScript type). The implementation was already inlined into upstream's `dist/index.mjs` and `dist/index.d.mts` but was not in upstream's published export list; the Botiverse repackage script (`scripts/repackage-sdk.mjs`) extends the trailing `export { ... }` block in place and appends `export { LocalKaos };` + `export type { Kaos };` to `index.d.mts`.

**Why:** Slock daemon's Kimi-SDK driver (in-process runtime) needs to inject per-agent CLI wrapper PATH into Kimi tool execution without polluting the daemon's own `process.env.PATH`. The supported path is `LocalKaos.create().then(k => k.withCwd(workdir).withEnv({ PATH: <agent-wrapper-dir>:$PATH }))`, then `harness.createSession({ ..., kaos })`. Without re-exporting `LocalKaos`, daemon callers cannot construct that kaos and have to fall back to absolute wrapper paths in the agent prompt, which proved unstable across long Kimi sessions (tygg/Hao #proj-runtime:96f626f3 6/20).

**Surface delta vs `@botiverse/kimi-code-sdk@0.18.0`:**
- New runtime export: `LocalKaos` (class with `create()` static factory + `withCwd` / `withEnv` chainable methods).
- New type export: `Kaos` (interface from `@moonshot-ai/kaos`, used as `KimiHarnessOptions.kaos` / `CreateSessionOptions.kaos` / `ResumeSessionInput.kaos`).
- Everything else identical to `@botiverse/kimi-code-sdk@0.18.0`.

**Verification:** new `scripts/verify-mirror-surface.mjs` asserts the published dist (a) has `LocalKaos` in the trailing JS export list, (b) re-exports `LocalKaos` + `Kaos` type in the `.d.mts`, (c) bundle still contains the `LocalKaos` implementation, (d) upstream symbols (`KimiHarness`, `Session`, `createKimiHarness`, `KimiError`) remain exported, and (e) when peer deps are installed, `import { LocalKaos } from <dist>` resolves to a class whose `.create()` returns a kaos with `.withEnv()`.

**Slock consumer impact:** opt-in. Default `pnpm add @botiverse/kimi-code-sdk` still resolves to the pure-repackage `0.18.0`. Daemon Kimi-SDK driver explicitly pins to `0.18.0-botiverse.0` to consume the new surface; older callers are unaffected.

---

## @moonshot-ai/kimi-code@0.18.0  (← 0.17.1)

**node-sdk public interface: ADDITIVE.** node-sdk `package.json` stays at `0.9.4`. New optional `sessionStartedProperties?: TelemetryProperties` field on three host surfaces:

- `KimiHarnessOptions.sessionStartedProperties` — host-default extra fields merged into every `session_started` telemetry event for that harness instance.
- `CreateSessionOptions.sessionStartedProperties` — per-session extra fields (overrides harness-default for that one session, but is itself overridden by canonical fields).
- `ResumeSessionInput.sessionStartedProperties` — same shape, applied on resume.

Merge precedence in `KimiHarness.trackSessionStarted` is fixed: harness-default → per-session → canonical fields. Canonical fields (`client_name`, `client_version`, `ui_mode`, etc.) always win, so callers cannot accidentally clobber them. Existing imports keep working.

**App / CLI features** (not consumed by SDK hosts directly, but shipped in same release):
- Web: scroll-up lazy loading for older session messages + new-messages pill fix (`#893`).
- Web: session search (`#895`).
- Web: paginated session list on load (`#882`).
- Web: drop workspace session count after archiving the last session (`#896`).
- Web: redesigned OAuth login dialog (`#867`).
- Web: server version shown in settings (`#889`).
- Web: improved slash menu and skill editing (`#878`); highlighted slash command stays visible in long menus (`#881`).
- Goal: guided goal authoring (`#839`).
- Server: report host kimi-code CLI version in `/meta` (`#879`).
- agent-core: cap AgentSwarm concurrency via env var (`#888`).
- Telemetry: merge duplicate session-start and goal events (`#885`).

**Slock consumer impact:** drop-in additive minor from `0.17.1`. Existing daemon code keeps working. The new `sessionStartedProperties` knob is purely additive — daemon may opt in later if we want host-side telemetry tagging on Kimi-driven sessions, but no change required to ship `0.18.0`.

---

## @moonshot-ai/kimi-code@0.17.1  (← 0.17.0)

**node-sdk public interface: NO change.** node-sdk `package.json` stays at `0.9.4` (bumped in 0.17.0); `src/index.ts` exports unchanged.

**App / CLI patches** (not consumed by SDK hosts directly, but shipped in same release):
- Prevent web login dialog from closing when clicking the backdrop (`#861`).
- Stop the background local server from locking the directory it was started in (`#860`).
- Fix the local server failing to start in the background on the native binary (`#860`).
- Group the default model dropdown in web settings by provider (`#861`).

**Slock consumer impact:** drop-in patch from `0.17.0`. No daemon code change required.

---

## @moonshot-ai/kimi-code@0.17.0  (← 0.16.0)

**node-sdk public interface: ADDITIVE.** node-sdk `package.json` bumped `0.9.3` → `0.9.4` (first internal version change since `0.9.3`). New public exports from `src/index.ts`:

- `loadRuntimeConfigSafe` — host-side safe config reader (returns parsed `KimiConfig` + diagnostics, doesn't throw on bad config).
- `resolveConfigPath` — sync helper that returns the canonical `<kimiHome>/config.toml` path.

Both exposed for hosts (e.g. CLI's server telemetry bootstrap) that need to inspect config without spinning up a full `KimiCore` / RPC. Existing imports keep working.

**Major upstream feature: server-hosted web UI** (`#625`):
- New CLI commands `kimi server` (start/stop/manage local server) + `kimi web` (open server-hosted web UI).
- Server REST + WebSocket APIs for the web client.
- `protocol/src/events.ts` +725 lines (new event classes for server↔web wire protocol).
- `protocol/src/ws-control.ts` +386 lines (new ws-control surface).
- New REST surfaces: snapshot, terminal, skill, modelCatalog, config, connection.
- **NOT consumed by Slock daemon's in-process kimi-sdk runtime** — we drive the SDK directly via `KimiHarness` / `Session`, the agent face is Slock, not the new bundled web UI.

**Other upstream changes:**
- `agent-core@0.13.x → ?`: many bundled-impl improvements (see CHANGELOG); upstream-version diffs covered by tsdown bundle in `dist`.
- `kosong / kaos / oauth`: bug fixes and protocol additions (see CHANGELOG).

**Slock consumer impact:**
- **Drop-in bump from `0.16.0`** — public SDK API stays compatible (additive only).
- New `loadRuntimeConfigSafe` + `resolveConfigPath` are useful for our daemon's `detectKimiSdkModels` (`packages/daemon/src/drivers/kimi-sdk.ts`) which currently does a narrow regex scan; a follow-up could replace the scan with `loadRuntimeConfigSafe(resolveConfigPath())` for cleaner config parsing and richer diagnostics. NOT required for `0.17.x` adoption — the existing scan still works.
- The new server/web feature surface (`kimi server`/`kimi web`/REST/WS) is **not on the Slock kimi-sdk runtime path** and ships as additional CLI surface only. No daemon driver change required to consume `0.17.x`.
- ⚠️ **RS-004 closed-mapping note:** if a future Slock daemon path ever subscribes to `KimiCore` event surface (the protocol-package event classes that ship with `0.17.x`), the daemon's `KimiSdkEvent` taxonomy in `packages/daemon/src/drivers/kimi-sdk.ts` would need extension per RS-004 (closed-mapping: each new event class → explicit map or drop, no wildcard). Current daemon's `KimiHarness` / `Session` event surface (assistant/thinking/tool/turn/compaction/agent.status/...) is unchanged in `0.17.x`, so RS-004 holds; this is a forward-looking flag for the helper-PR follow-up.

---

## @moonshot-ai/kimi-code@0.16.0  (← 0.15.0)

**node-sdk public interface: NO change.** node-sdk's `package.json` version stays at `0.9.3`; `src/index.ts` exports unchanged; no diff under `packages/node-sdk/` itself.

**Bundled-implementation siblings shipped notable runtime changes** — `tsdown` inlines `agent-core`, `kosong`, `kaos` into node-sdk's `dist`:

- **`agent-core@0.13.1`**:
  - fix: handle repeated compaction when context remains over the blocking threshold (`#813`).
  - fix: project session replay ranges over rendered replay records instead of raw persisted records (`#805`).
  - fix: prevent session shutdown from resuming the agent when stopping background tasks (`#804`).
  - chore: remove redundant LLM request logging context plumbing (`#823`).
- **`kosong@0.4.6`** fix: stop Anthropic-compatible providers from reading ambient Anthropic shell credentials and custom headers (`#790`) — host-isolation hardening; prevents a kosong-built daemon from picking up an out-of-band `ANTHROPIC_API_KEY` / extra headers from the host shell.
- **`kaos@0.1.6`** fix: close wrapped output streams when buffered readers are destroyed (`#807`) — resource-leak fix on the IO helper.

**Slock consumer impact:**
- Public SDK API unchanged; existing imports keep working.
- **Update to `@botiverse/kimi-code-sdk@0.16.0`** to pick up the compaction-loop / replay-range / shutdown-resume fixes (all relevant to long sessions and Slock's `daemon.runtime.turn` lifecycle), the kosong Anthropic-shell-credential isolation fix (relevant if a daemon ever runs alongside an `ANTHROPIC_API_KEY`-set shell), and the kaos stream-close fix.
- No breaking change; this is a drop-in bump.

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
- Public SDK API unchanged; existing imports keep working.
- **Update to `@botiverse/kimi-code-sdk@0.15.0`** to pick up the bundled-implementation refresh (improved system-prompt context, MCP-over-SSE, resume-interrupted-toolcalls fix, Xcode 26.5 MCP schema fix, etc.). This is the first npm publish under the new "align to upstream CLI tag" versioning policy — the version jump from `0.9.3`/`0.9.4` to `0.15.0` is intentional, not breaking.
- Earlier `0.9.3` and `0.9.4` are deprecated on npm; please migrate.

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
