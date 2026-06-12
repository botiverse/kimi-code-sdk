# kimi-code-sdk (Botiverse mirror)

A **read-only mirror** of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code),
maintained under the Botiverse org so Slock can consume Kimi Code's SDK against a
**stable, immutable, smoke-verified** set of pinned versions instead of pulling
directly from a fast-moving upstream.

> This repo is a mirror. **We do not fork or develop features here.** All code in
> `upstream-main` and the `release/*` branches is upstream's, under upstream's license.

---

## 1. Relationship to upstream

- **Read-only mirror, not a fork.** Source of truth is `MoonshotAI/kimi-code`.
- We mirror the **whole monorepo**, not just `packages/node-sdk` — the SDK depends on
  sibling workspace packages (`agent-core`, `kosong`, `kaos`), so extracting one package
  would break its dependency closure on every upstream refactor.
- Any change we'd want goes **upstream as a PR first**. If we ever genuinely need a local
  patch before upstream absorbs it, it lives on a `patch-*` branch stacked on the relevant
  release tag, is **registered in the table below**, and is **deleted once upstream lands it**.
  Mirror branches/tags themselves are never edited.

| Local patch branch | Based on tag | Reason | Upstream PR | Status |
|--------------------|--------------|--------|-------------|--------|
| _(none)_           |              |        |             |        |

## 2. Branch & tag model

| Ref | What it is |
|-----|-----------|
| `main` (default) | **Ours only** — this README + the sync CI. No upstream code. |
| `upstream-main` | Fast-forward mirror of upstream `main`. Moves forward daily; **never rewritten** (if upstream rewrites history, we hold and alert — see SOP). |
| `release/v<X.Y.Z>` | A readable branch pinned at upstream release `X.Y.Z` (for stacking a `patch-*` if ever needed). |
| `@moonshot-ai/kimi-code@<X.Y.Z>` (tag) | **Immutable mirror tag** = the exact upstream release name, frozen at our mirror. **This is what consumers pin.** |

### What Slock should consume
Pin an **immutable mirror tag**, never a moving branch:
```
github:botiverse/kimi-code-sdk#@moonshot-ai/kimi-code@0.14.2   # current pin
```
The immutability guarantee: even if upstream force-pushes or deletes a tag, our mirror tag
stays frozen at the commit it pointed to when we first mirrored it.

## 3. Version strategy

- Slock consumes **only mirror tags** (see "current pin" above). Never `upstream-main`.
- Bumping the pin is a deliberate change in the Slock consumer, made after the new mirror
  tag's smoke build is green here.
- The node-sdk package (`@moonshot-ai/kimi-code-sdk`) is versioned independently upstream
  (currently `0.9.3`) from the CLI release tag (`0.14.2`); we pin by the **release tag**.

## 4. License & attribution

All mirrored content is licensed under upstream's **MIT License** (see `LICENSE` on
`upstream-main` / each `release/*`). This mirror adds no new license; `main` carries only
this documentation and CI. Upstream copyright and `LICENSE` are preserved unchanged on the
mirror branches. See `NOTICE.md`.

## 5. Sync SOP

### How it syncs
- `.github/workflows/sync-upstream.yml` runs **daily (04:17 UTC)** and on manual
  **workflow_dispatch**.
- Each run: fetch upstream → **fast-forward** `upstream-main` → for every **new** upstream
  release tag create an immutable mirror tag + `release/v<X.Y.Z>` branch → **smoke build**
  the node-sdk → push. A smoke failure auto-opens a `sync` / `upstream-break` issue.

### Manual trigger
GitHub → Actions → **sync-upstream** → "Run workflow". (Or `gh workflow run sync-upstream.yml -R botiverse/kimi-code-sdk`.)

### One-time setup
Add repo secret **`SYNC_PAT`** = a PAT with `repo` + `workflow` scope. The default
`GITHUB_TOKEN` cannot push commits that touch upstream's `.github/workflows/**`, so the
ff-push needs `SYNC_PAT`. Upstream's own workflows live on `upstream-main` (not `main`), so
they do **not** run on schedule/dispatch (those use the default branch); to fully silence
push-triggered upstream CI, disable Actions for non-`main` branches or keep Actions limited.

### Smoke-failure triage runbook
1. **Open the failing run** (linked in the auto-issue).
2. **Decide: upstream-breaking vs our-env.**
   - Build/type error referencing upstream API changes → **upstream breaking change**.
     Consumers stay pinned to the last green mirror tag. File/track upstream; bump the
     Slock pin only after a green release tag lands.
   - `pnpm install` lockfile / toolchain / monorepo-layout error → **our env** (e.g.
     upstream moved `packages/node-sdk`). Update the smoke step's filter/paths in the
     workflow; the mirror tag is unaffected.
3. **Never edit the mirror** to make smoke pass — fix the smoke harness or wait for upstream.

### Known fragilities
- Upstream is pre-1.0 (`0.x`) and **will** ship breaking API changes — absorbed by
  smoke-at-sync + consumer pinning.
- If upstream changes its monorepo layout, the smoke build's `--filter`/paths must follow
  (this runbook, step 2).

## 6. Publishing `@botiverse/kimi-code-sdk` to npm

The repackaged, dist-only SDK (`@botiverse/kimi-code-sdk`) is published to npm via **OIDC
trusted publishing** (no long-lived token), **tag-triggered**, with the maintainer in the loop.

- **Version** = node-sdk's own `package.json` version (e.g. `0.9.3`), independent of the CLI
  release tag (`0.14.2`). `RELEASES.md` records the mapping.
- **Build artifact** = the bundled `dist` only (siblings are inlined by `tsdown`); deps reduce to
  the few light runtime ones. Upstream MIT `LICENSE` + our `NOTICE.md` ship in the tarball.
- **Workflow**: `.github/workflows/publish-sdk.yml`.

### How to publish a release

1. Pick the upstream mirror tag to ship (e.g. `@moonshot-ai/kimi-code@0.14.2`).
2. Write/confirm the interface release note (GitHub Release + `RELEASES.md`).
3. Tag the **same upstream-source commit** with a publish tag and push it:
   ```
   git tag publish-sdk/v0.9.3 '@moonshot-ai/kimi-code@0.14.2'
   git push botiverse publish-sdk/v0.9.3
   ```
   The workflow checks out that source, builds node-sdk, repackages, asserts the tag version
   matches the source `package.json` version (fails closed on mismatch), and publishes via OIDC.
   `workflow_dispatch` (with `source_tag`, `dry_run` default true) is the manual / dry-run path.

### One-time human setup (cannot be done from CI)

- On npmjs.com, configure the `@botiverse/kimi-code-sdk` **Trusted Publisher**: repo
  `botiverse/kimi-code-sdk`, workflow `publish-sdk.yml` (optional environment `npm-publish`).
- A brand-new package name may need one bootstrap publish by a logged-in `@botiverse`
  maintainer to create it; OIDC handles every release after.
- (Optional) protected GitHub Environment `npm-publish` with required reviewers = the manual
  approval gate before the publish step runs.

## 7. Ownership

- Maintainer: **@Kai** (Slock infra/runtime).
- Escalation: runtime/daemon owners in `#proj-runtime`.
