# Framework Portability Heuristics

## Why This Exists

SMIKE is more coherent as a framework now, but several planning and review heuristics still assume a JavaScript/monorepo layout. That is acceptable for the current repos, but it is too narrow for a framework that claims to work across different host-repo shapes.

This follow-up is intentionally separate from the first validation and ergonomics pass so portability work does not get mixed with correctness-hardening changes.

## Current Friction

- `checker.mjs` treats a plan as "code-bearing" only when `allowed_files` touch `packages/`, `tests/`, or `scripts/`.
- review heuristics in `cli.mjs` recognize only a narrow set of source, interface, test, and verification command patterns.
- current tests for those heuristics mirror the same repo shape, so portability regressions would be easy to miss.

## Goal

Generalize repo-shape and verification heuristics so host repos are judged by meaningful signals instead of one assumed directory structure or language stack.

## Proposed Work

1. Broaden default path heuristics.
   Cover common roots such as `src/`, `app/`, `apps/`, `server/`, `services/`, `lib/`, `pkg/`, and language-specific layouts where reasonable.

2. Separate source, interface, and test detection into reusable helpers.
   Keep the logic in one place so checker and review surfaces do not drift independently.

3. Expand verification command classification.
   Recognize common families such as `pytest`, `pyright`, `mypy`, `ruff`, `go test`, `cargo test`, `cargo check`, `bun test`, and repo-local wrappers that include those tools.

4. Add opt-in framework config for host-specific heuristics.
   A repo should be able to extend or override default path families and verification patterns without patching framework code.

5. Add portability-focused tests.
   Cover at least:
   - JS monorepo layout
   - single-package `src/` layout
   - Python service layout
   - Go or Rust package layout
   - repo-local wrapper commands that should still count as behavioral proof

## Non-Goal For This Pass

Do not redesign planning semantics. This work is about better signal classification, not changing the state machine or planning model.
