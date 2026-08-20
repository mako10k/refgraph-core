#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/refgraph-core-git-smoke.XXXXXX")
source_root="$temporary_root/source"
consumer_root="$temporary_root/consumer"
trap 'rm -rf -- "$temporary_root"' EXIT

mkdir "$source_root" "$consumer_root"
while IFS= read -r -d '' entry; do
  case "$entry" in
    dist | dist/*) continue ;;
  esac
  mkdir -p "$source_root/$(dirname "$entry")"
  cp -- "$package_root/$entry" "$source_root/$entry"
done < <(
  git -C "$package_root" ls-files --cached -z
  printf '%s\0' scripts/smoke-git-dependency.sh
)

git -C "$source_root" init --quiet
git -C "$source_root" add --all
git -C "$source_root" \
  -c user.name='refgraph-core smoke' \
  -c user.email='smoke@example.invalid' \
  commit --quiet --message='package fixture'
revision=$(git -C "$source_root" rev-parse HEAD)
dependency="git+file://$source_root#$revision"

cat >"$consumer_root/package.json" <<EOF
{
  "name": "refgraph-core-git-consumer-smoke",
  "private": true,
  "type": "module",
  "dependencies": {
    "@mako10k/refgraph-core": "$dependency"
  }
}
EOF
cat >"$consumer_root/consumer.mjs" <<'EOF'
import { RefGraph } from '@mako10k/refgraph-core'
if (typeof RefGraph !== 'function') throw new Error('RefGraph runtime export is missing')
EOF
cat >"$consumer_root/consumer.ts" <<'EOF'
import { RefGraph } from '@mako10k/refgraph-core'
const constructor: typeof RefGraph = RefGraph
void constructor
EOF

npm install \
  --prefix "$consumer_root" \
  --offline \
  --ignore-scripts=false \
  --no-audit \
  --no-fund
node "$consumer_root/consumer.mjs"
"$package_root/node_modules/.bin/tsc" \
  --noEmit \
  --strict \
  --module NodeNext \
  --moduleResolution NodeNext \
  --target ES2022 \
  "$consumer_root/consumer.ts"

installed_root="$consumer_root/node_modules/@mako10k/refgraph-core"
test -f "$installed_root/dist/index.js"
test -f "$installed_root/dist/index.d.ts"
unexpected=$(find "$installed_root" -type f \
  ! -path "$installed_root/LICENSE-MIT" \
  ! -path "$installed_root/README.md" \
  ! -path "$installed_root/package.json" \
  ! -path "$installed_root/dist/*" -print)
if [[ -n "$unexpected" ]]; then
  printf 'unexpected installed package files:\n%s\n' "$unexpected" >&2
  exit 1
fi

printf 'Git dependency smoke passed at fixture commit %s\n' "$revision"
