#!/usr/bin/env bash
set -euo pipefail
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$task_dir/../.." && pwd)"
cd "$repo_dir"
git diff --exit-code 87c39334619fbcb0c5782b061da1ba0df0ba3142 -- apps/backend/src libs/shared-types docker/open-weight-llm docker-compose.llm.yml package-lock.json > /dev/null || {
  printf 'Release source differs from the experiment baseline; use a separate clean checkout.\n' >&2
  exit 1
}
result_dir="${1:-$task_dir/results}"
mkdir -p "$result_dir"
result_dir="$(cd -- "$result_dir" && pwd)"
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node.js 24 for these experiment loaders")'
if [[ ! -e "$repo_dir/node_modules" ]]; then
  npm install --prefix "$task_dir" --ignore-scripts --no-audit --no-fund
  ln -s "$task_dir/node_modules" "$repo_dir/node_modules"
fi
node --test scripts/ci/open-weight-llm-runtime.test.mjs scripts/ci/open-weight-llm-compose-smoke.test.mjs > "$result_dir/existing-runtime-contracts.tap" 2>&1
node experiments/thema3/3a/build.mjs
node experiments/thema3/.build/run-controlled.mjs "$result_dir/3a"
node --import ./experiments/thema3/3c/loader.mjs experiments/thema3/3c/run.mjs "$result_dir/3c"
python3 -m unittest discover -s experiments/thema3/3b -p 'test_*.py' > "$result_dir/simulator-tests.log" 2>&1
printf 'Component experiments finished. Evidence: %s\n' "$result_dir"
printf 'Real inference is a separate run; no model-capacity claim follows from this command.\n'
