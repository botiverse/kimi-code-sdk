# kimi-code-sdk

A community-maintained, **read-only mirror + npm release pipeline** for [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code), so that any project wanting to embed Kimi Code's Node SDK can pin against a **stable, immutable, smoke-verified** version instead of pulling directly from a fast-moving upstream.

> This repo is a mirror. **We do not fork or develop features here.** All code in `upstream-main` and the `release/*` branches belongs to upstream, under upstream's MIT license. Anything we add lives only on `main` (this README + the CI workflows).

## Why this exists

Upstream Kimi Code is pre-1.0 (`0.x`) and ships breaking API changes through its private release process. Embedding the SDK directly via `MoonshotAI/kimi-code#main` means every upstream commit is a potential consumer break. This mirror solves that with three layers:

1. **Immutable mirror tags** (`@moonshot-ai/kimi-code@<X.Y.Z>`) — frozen at the commit upstream's release tag pointed at when we mirrored it. Even if upstream force-pushes or deletes a tag, our tag stays.
2. **Daily sync CI** that fast-forwards `upstream-main`, mirrors any new upstream release tag, and runs a **smoke build** of `packages/node-sdk` so upstream-breaking changes are caught at the sync boundary, not at consumer install time.
3. **OIDC-published npm package** [`@botiverse/kimi-code-sdk`](https://www.npmjs.com/package/@botiverse/kimi-code-sdk) — the dist-only repackage of the upstream node-sdk, so consumers don't have to pull the whole monorepo.

### Why not ACP?

ACP (Agent Client Protocol) doesn't expose a **steering** capability — i.e. you can't inject a follow-up instruction into a turn that's already in flight, or interleave a model-driven and operator-driven control signal on the same session. The Kimi Code Node SDK does expose this (`Session.prompt(...)` semantics), and that's load-bearing for embedders that need real-time interaction control. Until ACP grows steering, embedders have to integrate against the SDK directly — which is what this mirror enables.

---

## 1. Relationship to upstream

- **Read-only mirror, not a fork.** Source of truth is `MoonshotAI/kimi-code`.
- We mirror the **whole monorepo**, not just `packages/node-sdk` — the SDK depends on sibling workspace packages (`agent-core`, `kosong`, `kaos`, `oauth`), so extracting one package would break its dependency closure on every upstream refactor.
- Any change we'd want goes **upstream as a PR first**. If we ever genuinely need a local patch before upstream absorbs it, it lives on a `patch-*` branch stacked on the relevant release tag, is **registered in the table below**, and is **deleted once upstream lands it**. Mirror branches/tags themselves are never edited.

| Local patch branch | Based on tag | Reason | Upstream PR | Status |
|--------------------|--------------|--------|-------------|--------|
| `kai/0.20.1-botiverse-roleadditional` | `@moonshot-ai/kimi-code@0.20.1` | Thread an optional `roleAdditional` from `CreateSessionOptions`/`ResumeSessionInput` into the **main agent's** base system prompt (`{{ ROLE_ADDITIONAL }}`), rendered every request outside compressible history so a standing role protocol survives context compaction. Slock daemon Kimi driver needs a compaction-safe standing prompt. | _pending (to file)_ | **Active** — published as `@botiverse/kimi-code-sdk@0.20.1-botiverse.1`; delete once upstream lands. |

## 2. Branch & tag model

| Ref | What it is |
|-----|-----------|
| `main` (default) | **Ours only** — this README + the CI workflows. No upstream code. |
| `upstream-main` | Fast-forward mirror of upstream `main`. Moves forward daily; **never rewritten** (if upstream rewrites history, we hold and alert — see SOP). |
| `release/v<X.Y.Z>` | A readable branch pinned at upstream release `X.Y.Z` (for stacking a `patch-*` if ever needed). |
| `@moonshot-ai/kimi-code@<X.Y.Z>` (tag) | **Immutable mirror tag** = the exact upstream release name, frozen at our mirror. Source-level pin for vendoring or local patching. |

### What consumers should pin

**Recommended: `npm install`.** This gives you the dist-only repackage with just the few light runtime dependencies — no monorepo, no upstream toolchain, the typical consumer path:

```sh
# Find the current published version first — do not copy a version out of this file.
npm view @botiverse/kimi-code-sdk versions --json   # all published
npm view @botiverse/kimi-code-sdk version           # latest on the default dist-tag

npm install @botiverse/kimi-code-sdk@<version-you-just-read>
```

Use the mirror tag only when you actually need the full upstream monorepo source (vendoring, local patching, or studying):

```sh
# Less common — full monorepo source, much heavier.
# List the mirror tags, then pin one:
gh release list --repo botiverse/kimi-code-sdk
github:botiverse/kimi-code-sdk#@moonshot-ai/kimi-code@<tag-you-just-read>
```

> **Why no version number is written here.** Any version pasted into this README starts
> rotting the day it is written, and a stale example is indistinguishable from a current
> one — it does not error, it just quietly sends people to an old release. This file
> therefore documents *how to look the number up*, not what the number is. Anything below
> that genuinely is a fixed value carries an `as-of` date.

Both are immutable. The mirror tag stays frozen at the commit it pointed to when we first mirrored it, even if upstream force-pushes or deletes the upstream tag. The npm version is immutable per npm's own semantics.

`RELEASES.md` records the upstream-tag ↔ npm-version mapping plus interface notes per release.

### Mirror lag is normal, not a fault

**Syncing and publishing are two different things, and only the second one is installable.**
The daily CI (§5) mirrors upstream tags and smoke-builds them; it does **not** publish npm.
So at any moment the newest upstream release, the newest mirror tag, and the newest published
npm version can all be different. That is the expected steady state, not an outage.

Check all three yourself rather than assuming they match:

```sh
gh release list --repo MoonshotAI/kimi-code       # 1. what upstream has released
gh release list --repo botiverse/kimi-code-sdk    # 2. what this mirror has PUBLISHED
npm view @botiverse/kimi-code-sdk version         # 3. what npm will actually install
```

If 1 is ahead of 2, the mirror has not published that release yet. Consumers are unaffected:
your existing pin keeps working, because every published version is immutable. Nothing needs
to be done on the consumer side except stay pinned.

**Two rules that are easy to get wrong here, both learned the hard way:**

- **A green sync does not mean a release is available.** Only reading list 2 above tells you
  what is published. A green `sync-upstream` run means the tag was mirrored and smoke-built,
  which is a prerequisite for publishing, not evidence of it.
- **An upstream tag is not a pinnable artifact.** Upstream tags exist on the mirror as
  immutable source tags; that is not the same as an installable npm version. Only a published
  version can be pinned by an ordinary consumer.
- **Never compare tag *counts* to decide whether the mirror is current.** Counts can match
  while the contents differ, and can differ while nothing is wrong. Compare the actual
  newest names from lists 1 and 2.

## 3. Version strategy

- Consumers pin **only mirror tags** or **npm versions**, never `upstream-main`.
- Bumping a pin is a deliberate change in the consumer, made after the new mirror tag's smoke build is green here.
- The node-sdk package is versioned independently upstream from the CLI release tag — e.g. CLI tag `0.14.2` ships node-sdk `0.9.3`. The npm package `@botiverse/kimi-code-sdk` carries the **node-sdk version**; the GitHub Releases on this repo carry the **CLI release tag**. `RELEASES.md` is the bridge.

## 4. License & attribution

All mirrored content is licensed under upstream's **MIT License** (see `LICENSE` on `upstream-main` / each `release/*`). This mirror adds no new license; `main` carries only this documentation and CI. Upstream copyright and `LICENSE` are preserved unchanged on the mirror branches and in the published npm tarball. See `NOTICE.md`.

## 5. Sync SOP

### How it syncs
- `.github/workflows/sync-upstream.yml` runs **daily (04:17 UTC)** and on manual **workflow_dispatch**.
- Each run: fetch upstream → **fast-forward** `upstream-main` → for every **new** upstream release tag create an immutable mirror tag + `release/v<X.Y.Z>` branch → **smoke build** the node-sdk → push. A smoke failure auto-opens a `sync` / `upstream-break` issue.

### Manual trigger
GitHub → Actions → **sync-upstream** → "Run workflow". (Or `gh workflow run sync-upstream.yml -R botiverse/kimi-code-sdk`.)

### One-time setup
Add repo secret **`SYNC_PAT`** = a PAT with `repo` + `workflow` scope. The default `GITHUB_TOKEN` cannot push commits that touch upstream's `.github/workflows/**`, so the ff-push needs `SYNC_PAT`. Upstream's own workflows live on `upstream-main` (not `main`), so they do **not** run on schedule/dispatch (those use the default branch); to fully silence push-triggered upstream CI, disable Actions for non-`main` branches or keep Actions limited.

### Smoke-failure triage runbook
1. **Open the failing run** (linked in the auto-issue).
2. **Decide: upstream-breaking vs our-env.**
   - Build/type error referencing upstream API changes → **upstream breaking change**. Consumers stay pinned to the last green mirror tag. File/track upstream; bump consumer pins only after a green release tag lands.
   - `pnpm install` lockfile / toolchain / monorepo-layout error → **our env** (e.g. upstream moved `packages/node-sdk`). Update the smoke step's filter/paths in the workflow; the mirror tag is unaffected.
3. **Never edit the mirror** to make smoke pass — fix the smoke harness or wait for upstream.

### Known fragilities
- Upstream is pre-1.0 (`0.x`) and **will** ship breaking API changes — absorbed by smoke-at-sync + consumer pinning.
- If upstream changes its monorepo layout, the smoke build's `--filter`/paths must follow (this runbook, step 2).

### Daily check (the maintainer routine)

A green sync history proves the *pipeline* works. It does not prove the mirror is current
from a consumer's point of view, because publishing (§6) is a separate, human-gated step.
Those two facts drift apart silently: nothing fails, no issue is opened, and the repo simply
starts describing a release nobody can install. The routine below exists to make that drift
visible, and is run daily:

```sh
gh release list --repo MoonshotAI/kimi-code                          # 1. upstream releases
gh run list --repo botiverse/kimi-code-sdk --workflow sync-upstream  # 2. sync health
gh release list --repo botiverse/kimi-code-sdk                       # 3. what is PUBLISHED here
```

Each answers a different question, and they are not interchangeable:

| Reading | Question it answers | What it does **not** tell you |
|---|---|---|
| 1 | What has upstream released? | Whether any of it is mirrored or installable |
| 2 | Is the sync pipeline healthy? | Whether anything was published — a fully green history is compatible with nothing being published for months |
| 3 | What can a consumer actually install? | Whether it is the newest upstream release |

**Only reading 3 enables a pin bump.** Comparing 1 against 3 is the only comparison that
answers "can a consumer install the newest upstream release?". If 1 is ahead of 3, that is a
publish-side gap, not a sync failure, and §6 is the path that closes it — not a re-run of the
sync workflow.

## 6. Publishing `@botiverse/kimi-code-sdk` to npm

The repackaged, dist-only SDK (`@botiverse/kimi-code-sdk`) is published to npm via **OIDC trusted publishing** (no long-lived token), **tag-triggered**, with the maintainer in the loop.

- **Version** = node-sdk's own `package.json` version (e.g. `0.9.3`), independent of the CLI release tag (`0.14.2`). `RELEASES.md` records the mapping.
- **Build artifact** = the bundled `dist` only (siblings are inlined by `tsdown`); deps reduce to the few light runtime ones. Upstream MIT `LICENSE` + our `NOTICE.md` ship in the tarball.
- **Workflow**: `.github/workflows/publish-sdk.yml`.

### How to publish a release

1. Pick the upstream mirror tag to ship (e.g. `@moonshot-ai/kimi-code@0.14.2`).
2. Write/confirm the interface release note (GitHub Release + `RELEASES.md`).
3. Tag the **same upstream-source commit** with a publish tag and push it:
   ```
   git tag publish-sdk/v0.9.3 '@moonshot-ai/kimi-code@0.14.2'
   git push botiverse publish-sdk/v0.9.3
   ```
   The workflow checks out that source, builds node-sdk, repackages, asserts the tag version matches the source `package.json` version (fails closed on mismatch), and publishes via OIDC. `workflow_dispatch` (with `source_tag`, `dry_run` default true) is the manual / dry-run path.

### One-time human setup (cannot be done from CI)

- On npmjs.com, configure the `@botiverse/kimi-code-sdk` **Trusted Publisher**: repo `botiverse/kimi-code-sdk`, workflow `publish-sdk.yml` (optional environment `npm-publish`).
- A brand-new package name may need one bootstrap publish by a logged-in `@botiverse` member to create it; OIDC handles every release after.
- (Optional) protected GitHub Environment `npm-publish` with required reviewers = the manual approval gate before the publish step runs.

## 7. Contributing

This repo is intentionally minimal. The kinds of changes we welcome on `main`:

- Improvements to the sync CI (`.github/workflows/sync-upstream.yml`) — e.g. better triage hints in the auto-opened issues, more robust ff-guard behaviour.
- Improvements to the publish pipeline (`.github/workflows/publish-sdk.yml`, `scripts/repackage-sdk.mjs`).
- Documentation: clarifications to this README, the runbooks, or `RELEASES.md` interface notes.

What we will **not** accept:
- Changes to mirrored upstream code on `upstream-main` or `release/*` — those go upstream as a PR first.
- Edits to existing mirror tags — they're immutable by design.
- Local feature work that should belong upstream.

If you need a feature that upstream hasn't shipped, open the PR upstream and (if absolutely necessary in the meantime) propose a `patch-*` branch here registered in the table in §1.

## 8. Maintainer

- Maintainer: **@Kai** (issue and PR triage).
- Escalation for sync/publish-pipeline issues: open an issue on this repo.
