# SMIKE Framework

Externalized SMIKE control-plane code for local project repos.

This repo is the canonical framework source. Host repos keep their own product code and a thin local `./smike` wrapper that resolves this framework through `smike.config.json`.

## Layout

- `scripts/smike/` — canonical CLI, schemas, templates, and runtime docs
- `docs/` — framework-specific design notes and cleanup plans
- `smike` — direct launcher for framework-local development

## Project Integration

A consuming repo should keep:

- a local `./smike` wrapper
- a local `scripts/smike/cli.mjs` dispatcher
- project state in `.smike/`
- product planning docs in the project repo

The Family Tech Platform repo resolves this framework through `smike.config.json` with `framework_dir` pointing at this repo checkout.

## Repo Split

- `smike-framework/` holds the canonical SMIKE CLI, schemas, templates, and framework docs.
- A host repo such as Family Tech Platform keeps its app code, product docs, runtime state, and repo-local shims.
- Host repos should not track generated `.smike/` runtime state, local env files, or editor/Xcode user-state.

Operational note:

- `./smike` is the universal entrypoint. With an active or selected project, it should resolve to the correct legal next step automatically.
- `./smike resume [project]` and `./smike status [project]` are inspection-only.
- `./smike advance <project>` is the execution entrypoint for “do the legal next thing” from the current lifecycle state.
- `.smike/<project>/STATE.md` is the canonical operator handoff view. Read it first in a fresh Codex session; treat `IMPLEMENTATION-HANDOFF.json` and `PLANNING-HANDOFF.md` as supporting projections.
- `./smike "<short prompt>"` auto-routes lightweight requests into an onboarding draft spec in `memories/`, then continues through the normal `planning_draft` flow.
