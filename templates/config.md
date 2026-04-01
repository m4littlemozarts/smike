# Project Config Template

Template for `.smike/config.md` — lean autorun defaults.

---

## File Template

```markdown
# Project Config
Project: {project name}
Created: {timestamp}

## Preferences
auto_accept_plans: true
logging: false
review_mode: risk-only
tdd_default: true
```

---

## Settings Reference

| Setting | Values | Default | Effect |
|---------|--------|---------|--------|
| auto_accept_plans | true/false | true | Plans auto-execute without user approval |
| logging | true/false | false | Subagents write LOG.md entries per cycle |
| review_mode | always/risk-only/never | risk-only | When JUDGE dispatches code review subagent |
| tdd_default | true/false | true | Default TDD flag when strategist can't determine |

### review_mode behavior
- **always:** JUDGE dispatches review subagent for every plan (FULL mode only)
- **risk-only:** JUDGE dispatches review subagent only in FULL mode (default — LIGHT mode skips review)
- **never:** JUDGE never dispatches review subagent; verification only

### tdd_default behavior
Strategist sets `tdd: true/false` per plan based on whether tasks have testable behavior.
When the strategist can't determine (ambiguous), it falls back to this config value.

---

## Guidelines

**What belongs in config.md:**
- User preferences for SMIKE behavior
- Workflow toggles (logging, review, TDD)

**What does NOT belong here:**
- Sensitive credentials (use environment variables)
- Build configuration (use native config files)
- Project requirements (that's PROJECT.md)
- Roadmap information (that's ROADMAP.md)
