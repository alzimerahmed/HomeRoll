# HomeRoll — Rules for AI Agents

## Project

HomeRoll = self-hosted photo & video backup and gallery app (based on Immich, AGPLv3; upstream: https://github.com/immich-app/immich; our repo: https://github.com/alzimerahmed/HomeRoll, owner: Alzimer Ahmed <alzimerahmed84@gmail.com>). Inherits the Immich feature set: multi-user libraries, mobile auto-backup, album sharing, map/timeline views, ML-powered search (CLIP + facial recognition), external libraries, partner sharing, stack/duplicate handling. Differentiation: clean HomeRoll branding, privacy-first, no upstream telemetry/donation links.

**License:** AGPL-3.0. Upstream `LICENSE` must be preserved — AGPLv3 does not permit relicensing. Our additions carry our copyright notice; upstream copyright stays in LICENSE and source headers where required.

**Scope:** Full monorepo — NestJS server + SvelteKit web + Flutter mobile + Python ML service + OpenAPI SDKs + Docker deployment. All verification is CI-only (see Build/Verify).

## How It Works (domain constraints — read before touching the code)

- **`server/`** is the NestJS API (TypeScript): REST + WebSocket gateway, domain modules under `server/src/`, repositories + Kysely SQL layer in `server/src/infra` (naming varies by upstream version — check), BullMQ job queues backed by Redis, unit tests co-located. Domain/business logic lives here — treat it as the trusted core.
- **`web/`** is the SvelteKit 2 + Svelte 5 client: `web/src/routes/` (pages), `web/src/lib/` (components, stores, utils), Tailwind CSS, Vitest unit tests, generated API client from `open-api/typescript-sdk`.
- **`mobile/`** is the Flutter app (Dart): `mobile/lib/` (Riverpod providers, pages, services), `mobile/test/`, drift/SQLite for local DB, generated API client from `open-api/dart`.
- **`machine-learning/`** is the Python FastAPI service: CLIP embeddings, facial recognition, smart search — deps via `uv`/`poetry` (check upstream lockfile).
- **`open-api/`** is the API contract layer: `immich-openapi-specs.json` is generated from server decorators — **never hand-edit the spec or generated SDKs**; regenerate via the repo's openapi scripts.
- **`packages/`** — shared pnpm workspace packages (`sdk`, `cli`, `plugin-sdk`, `plugin-core`, `scripts`, `e2e-auth-server`).
- **`i18n/`** — all locale JSON files at repo root (Weblate-managed upstream). New user-facing strings go in `en.json` first; never batch-edit other locales.
- **`native/`** — Rust crates (native_core) used by the mobile app.
- **`e2e/`** — API end-to-end tests against a running server.
- **`deployment/`**, **`design/`**, **`misc/`** — deploy manifests/assets, design assets, misc tooling.
- **`docs/`** — Docusaurus documentation site (repo source, tracked). Our private knowledge layer (`docs/*.md` at the top level) is gitignored and coexists with it — never put knowledge files inside `docs/docs/` or `docs/src/` (those are the site). `docs/README.md` is a tracked upstream file (explicitly un-ignored).
- **`docker/`** — docker-compose deployment files (dev + prod examples).
- **`fastlane/`** — mobile release metadata/screenshots (Fastlane).
- **`readme_i18n/`** — translated READMEs (upstream community translations).
- **Database**: PostgreSQL with vector extension (pgvecto.rs / VectorChord — check `server/` migrations). Schema changes = new migration files only; never edit applied migrations.

## Tech Stack & Conventions (do not fight it)

- **TypeScript** everywhere in server/web/packages; **strict ESLint + Prettier** — respect existing configs (`server/eslint.config.mjs`, `web/eslint.config.js`, prettier config files).
- **pnpm monorepo** (`pnpm@11.28.5`, `pnpm-workspace.yaml`, root `package.json` = `immich-monorepo`) for server/web/packages/open-api/e2e; **Flutter/Dart** (`pubspec.yaml`, `pigeon`, drift) for mobile; **Python 3 + uv** for machine-learning; **Rust** for `native/` crates.
- **mise** (`mise.toml` per package) pins tool versions — CI/dev use the same versions; don't hardcode toolchain versions ad hoc.
- **Commits**: Conventional Commits (`type(scope): description`); upstream history is gone — this repo has fresh history.
- **Brand identity**: HomeRoll branding (name, URLs, package/display names where safe) is a planned phase — CI-verified; never change ad hoc. Directory names (`server`, `web`, `mobile`, `machine-learning`) and internal identifiers (`immich` in paths/env vars like `IMMICH_*`, `DB_*`) remain upstream-named for stability until the rename phase.
- **Upstream sync**: we track recent upstream; treat `server/`, `web/`, `mobile/` internals as upstream-owned — prefer additive changes over invasive refactors so future upstream merges stay cheap.

## Build / Verify

```bash
# CI (GitHub Actions, .github/workflows/ — PR to main + manual):
#   checks / test workflows — lint, typecheck, unit tests (server vitest,
#   web vitest, flutter test, python pytest), build per package.
```

**Remote-first verification (mandatory):** we do NOT build or test locally — this workspace is Windows and all builds/tests run in GitHub Actions. Local work is edit-only: static review while iterating. Push and let CI verify; a CI green check counts as the gate.

**Images & deploy:** CI runs lint/build/test only — no Docker image publishing, no signing, no deployments. Workflows that need secrets (GHCR/DockerHub push, Weblate sync, release automation) are removed or stubbed in a Foundation phase; never add secret-dependent jobs until a Release phase provisions them.

## Removed on Purpose — Do NOT Re-add

- Upstream monetization/donation endpoints: GitHub Sponsors, buy-me-a-coffee, merchandise, `FUNDING.yml` donation entries — replaced with HomeRoll identity.
- Upstream marketing links to immich.app where they would ship inside the product (buy links, hosted-demo CTAs).
- Secret-dependent workflows — none exist; do not add ones requiring secrets we don't have.

## Gotchas

- **No local build safety net** — grep all references (workflows, docker-compose, env examples, package.json scripts, pubspec.yaml, imports) before deleting or renaming anything.
- **`docs/` dual-use** — repo's Docusaurus site lives here AND our gitignored knowledge layer `docs/*.md`. `.gitignore` must ignore only `docs/*.md` top-level files, never `docs/**`.
- **OpenAPI regeneration** — server decorators are the source of truth; web/mobile SDKs are generated. Editing generated files by hand is a review blocker.
- **`IMMICH_*` env vars, `immich-*` docker service names** — public-facing config surface; renaming is a planned phase (breaking change), not an ad-hoc edit.
- **Monorepo version drift** — `server/package.json`, `web/package.json`, `mobile/pubspec.yaml`, `machine-learning/pyproject.toml` all carry the app version; a release phase aligns them.
- **Windows checkout**: symlinked docs/assets and case-sensitive paths can be hostile; avoid `git clean -fdx`.
- **AGPLv3**: no proprietary additions; third-party deps must stay AGPL-compatible.

## Agent Guidelines & Constraints

### Do's
- **Write tests** for new behavior (vitest in `server/`/`web/`, `flutter test` in `mobile/`, pytest in `machine-learning/`); run in CI only.
- **Conventional Commits** for our changes.
- **Respect module boundaries** — API/domain logic in `server/`, UI in `web/`/`mobile/`, ML in `machine-learning/`; share contracts only through `open-api/`.
- **Plan discipline** — `docs/plan.md` must contain a Quality Gate phase and a Release phase. Every `idea.md` Feature Gap entry maps to a phase or is explicitly deferred. When a phase answers an open question in `docs/research.md`, close it there in the same change.

### Don'ts
- **NO local builds or test runs** — verification is CI-only (user directive; Windows host).
- **NO secrets in code** — docker/registry/deploy credentials via CI secrets only; none exist yet.
- **NO new heavy dependencies** without a decision record in `docs/research.md` (license must stay AGPL-compatible).
- **NO deleting resources** without grepping all reference types (package.json, pubspec.yaml, pyproject.toml, workflows, docker-compose, imports).
- **NO renaming env vars/service names/product strings ad hoc** — that is a planned phase, CI-verified.
- **NO hand-editing generated files** — OpenAPI spec, generated SDKs, lockfiles, locale files other than `en`.

## Agent Guidelines & Workflow (this repo's .devin system)

### Resource Discipline (mandatory, non-trivial tasks)
Before any non-trivial task:
1. Read `docs/toolset.md` intent-map (task type → resources)
2. Invoke every skill + sub-agent in that row
3. Read every rule for that task type (`.devin/rules/`)
4. At task end: `code-reviewer` sub-agent on final diff (non-negotiable)
5. Append learnings via `/ce-compound` if durable lesson

Phase implementations (task completes a docs/plan.md row): follow `.devin/prompt/phase.md`.

Skip all this for single-line edits, pure Q&A, reading files.

### Project-Type Filter (self-hosted photo gallery monorepo)
Per `docs/toolset.md` intent-map:
- **Skip irrelevant:** payment-integrator (no commerce), design-cloner (existing product UI, not a site clone), web-scraper (no scraping), email-engineer only if notification phases arrive, pwa-engineer only if offline-first web is planned.
- **Keep universal:** code-reviewer, debugger, test-engineer, security-auditor, performance-engineer, git-master, migration-specialist, docs-writer, build-optimizer, devops-engineer, dx-optimizer, caveman-compressor, vibe-coding-auditor.
- **Keep domain-fit:** frontend-designer (web UI taste), design-system-builder, css-architect (Tailwind), animation-engineer, media-optimizer (core domain — photo/video pipeline), content-writer, i18n-specialist, state-manager, file-handler (uploads = core), search-architect (search = core), realtime-engineer (WebSocket jobs), database-engineer (Postgres/Kysely), analytics-engineer (privacy-first only), backend-architect, monorepo-manager, type-safety-engineer, pixel-analyst, a11y-specialist, researcher, seo-specialist (docs/marketing surface only).
- **Quality gates:** CI-only — lint + typecheck + unit tests per package on GitHub Actions. No local builds.

## Communication Style

Default **caveman-lite** (lightly compressed, readable, technically accurate). `/caveman` skill for full/ultra/wenyan modes.

## Quick Task Flow

Quick tasks: `.devin/prompt/quick.md` (commandments) + `.devin/prompt/rules.md` (scoping, verification, escalation). Phased work: `.devin/prompt/phase.md`.

## Key References

> Note: `docs/*.md` files below are the private knowledge layer (gitignored) — they exist only in the local workspace, not for external cloners. Repo docs site lives under `docs/docs/` + `docs/src/` and IS tracked.

- `docs/toolset.md` — intent map (task type → skills, sub-agents, rules)
- `docs/plan.md` — phased plan + status
- `docs/project.md` — project state/structure
- `docs/tools-log.md` — .devin resources invoked per session
- `docs/CONCEPTS.md` — project vocabulary
- `docs/research.md` — research, ADRs, gotchas, open questions
- `docs/idea.md` — competitive analysis + Feature Gap List
- `docs/design/design-system.md` — UI tokens + rules
