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

Operational note:

- `./smike` is the control-plane entrypoint, not the whole workflow. If it leaves `STATE.json.lifecycle.status` at `awaiting_runtime_dispatch` or `awaiting_fresh_session`, the host runtime must run `STATE.json.lifecycle.next_command` before treating the project as settled.
- `./smike advance <project>` is the convenience command for “do the legal next thing” from the current lifecycle state.
