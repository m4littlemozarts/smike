# Invalid Missing Priority Summary

## Objective
Exercise the plan-quality guard that rejects fallback phase summaries.

## What The Planner Must Read First
- scripts/smike/cli.mjs

## Required Deliverable From This Loop
- A bounded CLI validation change.

## Required Planning Output Shape
- Plan 01: Add plan-quality validation command (write_scope:scripts/smike/cli.mjs; verify:printf plan-quality-cli-proof scripts/smike/cli.mjs)
