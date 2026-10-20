# Contributing to HomeRoll

Thanks for your interest in contributing. HomeRoll is a fork of [Immich](https://github.com/immich-app/immich) — most contribution mechanics follow upstream conventions, adapted for this repository.

## Development setup

All toolchains are pinned by [mise](https://mise.jdx.dev) (`mise.toml` + per-package roots). You need mise and Docker; everything else comes from mise.

```bash
mise install                       # node, pnpm, java, flutter, python, uv, rust, jellyfin-ffmpeg, ...
pnpm install --frozen-lockfile     # workspace dependencies
mise run dev                       # full dev stack via docker/docker-compose.dev.yml
```

Each package has mise tasks for verification — `check:code` (format + lint + typecheck), `checklist`, and `ci-unit`. Run the task for the package you touched (e.g. `mise run //server:checklist`).

### CI-only verification

HomeRoll is developed on a Windows host with **CI-only verification** (ADR-005): the full test matrix runs in GitHub Actions — `test.yml`, `static_analysis.yml`, `check-openapi.yml`, `migration-order.yml`. You are not expected to run the whole suite locally. Open a **draft PR early** so CI can verify while you iterate.

### Generated files — never hand-edit

`open-api/immich-openapi-specs.json`, `packages/sdk/src/fetch-client.ts`, `mobile/generated/openapi/`, `server/src/queries/*.repository.sql`, and drift/freezed/`*.g.dart` files are generated and committed. Regenerate via `mise run open-api`, `mise run sql`, or the `mobile/` codegen tasks. CI fails on drift.

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, etc. Keep the subject line ≤72 characters.

## Pull requests

- One PR does one thing. Small, focused PRs review and merge faster.
- Fill out the PR template completely — `auto-close.yml` enforces it.
- Open a draft early for CI feedback (see CI-only verification above).
- Prefer new files over edits to upstream files where practical — it keeps the upstream re-import patch series manageable.

## Translations (i18n)

Edit **`i18n/en.json` only** — it is the source of truth. The other ~86 locale files are managed through the translation platform; do not hand-edit or machine-translate them in PRs.

## License

HomeRoll is licensed [AGPL-3.0](LICENSE). By contributing, you agree your contributions are licensed under AGPL-3.0. New dependencies must be AGPL-compatible (no SSPL/Commons Clause).

## Heritage

This document is adapted from the upstream Immich `CONTRIBUTING.md`. For upstream bugs that also exist in Immich, consider reporting them at [immich-app/immich](https://github.com/immich-app/immich) as well.
