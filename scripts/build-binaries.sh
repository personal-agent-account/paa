#!/bin/sh
# paa の単体実行ファイルを作る(PBI-0132)。end user から bun を剥がすための前半 ——
# 「置いてあれば使う」側は launcher(packages/mcp/atn-mcp)と resolveMcpServerCommand が持つ。
#
#   ./scripts/build-binaries.sh                    配布 target 全部(darwin-arm64 / darwin-x64 / linux-x64)
#   ./scripts/build-binaries.sh --host-only        今の機械向けだけ → dist/atn-mcp, dist/atn
#   ./scripts/build-binaries.sh --host-only atn-mcp  1 本だけ
#   ./scripts/build-binaries.sh --out /tmp/x       出力先を変える
#
# **binary は git に入れない**(1 本 61MB)。dist/ は .gitignore 済み。
# Release への添付と `atn install` からの自動取得は PBI-0137(本 PBI のスコープ外)。
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
out="${PAA_DIST:-$repo/dist}"
host_only=0
names=""

while [ $# -gt 0 ]; do
  case "$1" in
    --host-only) host_only=1 ;;
    --out) shift; out="$1" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) names="$names $1" ;;
  esac
  shift
done
[ -n "$names" ] || names="atn-mcp atn"

entry_for() {
  case "$1" in
    atn-mcp) echo "packages/mcp/src/server.ts" ;;
    atn) echo "apps/cli/src/paa.ts" ;;
    *) echo "unknown binary: $1 (atn-mcp | atn)" >&2; exit 2 ;;
  esac
}

mkdir -p "$out"
cd "$repo"

for name in $names; do
  entry=$(entry_for "$name")
  if [ "$host_only" -eq 1 ]; then
    echo "build $name (host)"
    bun build "$entry" --compile --outfile "$out/$name"
  else
    for target in bun-darwin-arm64 bun-darwin-x64 bun-linux-x64; do
      echo "build $name (${target#bun-})"
      bun build "$entry" --compile --target="$target" --outfile "$out/$name-${target#bun-}"
    done
  fi
done

echo "done -> $out"
