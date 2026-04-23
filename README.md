# SMIKE Framework

Externalized SMIKE control-plane code for local project repos.

This repo is the canonical framework source. Host repos keep their own product code and a small local `./smike` launcher that resolves this framework through `smike.config.json`.

## Layout

- `scripts/smike/` — canonical CLI, schemas, templates, and runtime docs
- `docs/` — framework-specific design notes and cleanup plans
- `smike` — direct launcher for framework-local development

## Development

- `npm install` installs the framework's local dependencies
- `npm test` runs the framework test suite
- `npm run validate` runs the repo-root verification pass for framework changes

Framework health checks before contract or lifecycle changes:

- `node --check scripts/smike/cli.mjs`
- `npm test`
- `./smike validate --contracts`
- `./smike validate --compatibility`

Treat `npm test` as the green-bar signal. Treat compatibility validation as an
inventory and migration signal: known historical artifacts may report
`migratable` or `unsupported` until they are explicitly normalized, archived, or
declared unsupported.

## Project Integration

A consuming repo should keep:

- a local `./smike` launcher
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
- `./smike <spec.md> [context.md ...]` parses only the first file as the spec. Later files are context refs and do not satisfy required spec headings.
- `./smike <spec.md> [context.md ...]` runs the framework spec-prep pass first. That pass may rewrite a managed `SMIKE:CONTRACT` block in the first file so parser-facing headings, phase lines, and proof commands are present.
- `./smike resume [project]` and `./smike status [project]` are inspection-only.
- `./smike advance <project>` remains the exact lifecycle authority and recovery/debug surface exposed through `STATE.json.lifecycle.next_command`.
- `.smike/<project>/STATE.md` is the canonical operator handoff view. It is rendered from `STATE.json` for readability; `STATE.json` remains the machine authority.
- `STATE.json.lifecycle.advance_behavior` tells you what `./smike advance <project>` will do from the current state.
- `PLAN.json#planning_context` is the canonical planning context. Narrative planning docs are no longer required runtime artifacts.
- `./smike "<short prompt>"` or `./smike intake "<short prompt>" --context=path1,path2 --spec=memories/name.md` writes an onboarding draft spec, then continues through the normal `planning_draft` flow.
- `planning_draft` is spec-driven: refine the main spec file, not generated `.smike/**` artifacts. The next `./smike cycle <project>` rebuilds planning artifacts from the spec and promotes only when summaries, write scopes, dependency shape, and verify commands are concrete enough.
