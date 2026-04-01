#!/usr/bin/env bash
# SMIKE framework — plan structural validation
# Usage: validate-plans.sh <plan_path> [<plan_path> ...]
# Exit codes: 0 = all pass, 1 = failures found

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
NC='\033[0m'

failures=0
warnings=0
total_tasks=0
total_files=0

validate_plan() {
  local plan="$1"
  local plan_name
  plan_name=$(basename "$plan")

  # 1. File exists and is non-empty
  if [ ! -s "$plan" ]; then
    echo -e "${RED}FAIL${NC}: $plan_name — file missing or empty"
    ((failures++))
    return
  fi

  # 2. Required top-level XML sections (anchored to line start to skip code blocks)
  for section in objective acceptance_criteria tasks boundaries verification; do
    if ! grep -q "^<${section}>" "$plan"; then
      echo -e "${RED}FAIL${NC}: $plan_name — missing <${section}> section"
      ((failures++))
    fi
  done

  # 3. Count task blocks (exclude the <tasks> container itself)
  local task_count
  task_count=$(grep -c '<task[ >]' "$plan" 2>/dev/null || echo 0)
  # Subtract <tasks> container matches
  local container_count
  container_count=$(grep -c '<tasks>' "$plan" 2>/dev/null || echo 0)
  task_count=$((task_count - container_count))

  if [ "$task_count" -eq 0 ]; then
    echo -e "${RED}FAIL${NC}: $plan_name — no <task> blocks found"
    ((failures++))
    return
  fi

  if [ "$task_count" -gt 5 ]; then
    echo -e "${RED}FAIL${NC}: $plan_name — too many tasks ($task_count > 5)"
    ((failures++))
  fi

  total_tasks=$((total_tasks + task_count))

  # 4. Required child tags inside each task
  for tag in name files action verify done; do
    local child_count
    child_count=$(grep -c "^  *<${tag}>" "$plan" 2>/dev/null || echo 0)
    # Also count tags at line start (no indent)
    local child_count_noi
    child_count_noi=$(grep -c "^<${tag}>" "$plan" 2>/dev/null || echo 0)
    child_count=$((child_count + child_count_noi))

    if [ "$child_count" -lt "$task_count" ]; then
      echo -e "${RED}FAIL${NC}: $plan_name — <${tag}> count ($child_count) < task count ($task_count)"
      ((failures++))
    fi
  done

  # 5. FORMAT_DRIFT detection — hybrid markdown inside <task> wrappers
  # Check for markdown headers or bold labels inside the <tasks> section
  local md_headers
  md_headers=$(sed -n '/<tasks>/,/<\/tasks>/p' "$plan" | grep -c '^\(##\|###\|  ##\|  ###\)' 2>/dev/null || echo 0)
  local bold_labels
  bold_labels=$(sed -n '/<tasks>/,/<\/tasks>/p' "$plan" | grep -c '^\*\*\(Files\|Action\|Verify\|Done\|Name\)\b' 2>/dev/null || echo 0)

  if [ "$md_headers" -gt 0 ] || [ "$bold_labels" -gt 0 ]; then
    echo -e "${RED}FORMAT_DRIFT${NC}: $plan_name — markdown inside <task> blocks (${md_headers} headers, ${bold_labels} bold labels)"
    ((failures++))
  fi

  # 6. Count files for summary
  local file_count
  file_count=$(grep -c '<files>' "$plan" 2>/dev/null || echo 0)
  total_files=$((total_files + file_count))

  # 7. File path validation — check existing parent directories
  local file_paths
  file_paths=$(sed -n 's/.*<files>\(.*\)<\/files>.*/\1/p' "$plan" 2>/dev/null || true)
  if [ -n "$file_paths" ]; then
    # Split comma-separated paths and check parents
    echo "$file_paths" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | while read -r fpath; do
      [ -z "$fpath" ] && continue
      local pdir
      pdir=$(dirname "$fpath")
      # Only warn if grandparent exists but parent doesn't (likely typo)
      if [ -d "$(dirname "$pdir")" ] && [ ! -d "$pdir" ] && [ "$pdir" != "." ]; then
        echo -e "${YELLOW}WARN${NC}: $plan_name — parent dir does not exist: $pdir"
        ((warnings++)) 2>/dev/null || true
      fi
    done
  fi
}

# Main
if [ $# -eq 0 ]; then
  echo "Usage: validate-plans.sh <plan_path> [<plan_path> ...]"
  exit 1
fi

plan_count=0
for plan_path in "$@"; do
  validate_plan "$plan_path"
  ((plan_count++))
done

echo ""
if [ "$failures" -gt 0 ]; then
  echo -e "${RED}Dry run: ${plan_count} plans checked — ${failures} failure(s), ${warnings} warning(s)${NC}"
  exit 1
else
  echo -e "${GREEN}Dry run: ${plan_count} plans validated, ${total_tasks} tasks structured. ✓${NC}"
  exit 0
fi
