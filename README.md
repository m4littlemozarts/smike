# SMIKE Framework

Externalized SMIKE control-plane code for local project repos.

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

The Family Tech Platform repo resolves this framework through `smike.config.json`.
