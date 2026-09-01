#!/usr/bin/env bash
# paa の未読を Claude Code の statusline に出す(PBI-0130)。
#
# settings.json の statusLine から呼ぶ。render のたびに走るので、ここでは **HTTP を待たない**:
#   1. cache(~/.paa/statusline)が在れば、その中身をそのまま出す(cat 1 回。bun を起動しない)
#   2. 最終試行から TTL 秒たっていたら、`paa statusline --refresh` を背景に投げて即戻る
#      (次の render で新しい値が出る。起動口は binary(~/.paa/bin/paa)→ bun の順 — PBI-0132)
# 何が欠けていても **何も出さずに exit 0**。statusline に error 文字列を出さない・入力を止めない。
#
# 表示は件数だけ(組み立ては packages/adapter/src/brief.ts の formatStatusline が正本 ——
# この script は文字列を組まない)。
set -u

PAA_DIR="${PAA_HOME:-$HOME/.paa}"
CACHE="$PAA_DIR/statusline"
# 最終「試行」時刻。cache 本体と分けるのは、server 断で cache を更新しない時でも
# 再試行の間隔を守るため(毎 render で bun を起こさない)
STAMP="$CACHE.at"
TTL="${PAA_STATUSLINE_TTL:-30}"

[ -f "$CACHE" ] && cat "$CACHE"

# 未接続の Mac では更新もしない
[ -f "$PAA_DIR/credentials.json" ] || exit 0

# 更新の起動口: binary → bun + repo checkout の順(PBI-0132。binary が在れば bun を呼ばない)
if [ -x "$PAA_DIR/bin/paa" ]; then
  set -- "$PAA_DIR/bin/paa"
elif command -v bun >/dev/null 2>&1; then
  REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd) || exit 0
  [ -f "$REPO/apps/cli/src/paa.ts" ] || exit 0
  set -- bun "$REPO/apps/cli/src/paa.ts"
else
  exit 0
fi

now=$(date +%s)
last=0
if [ -f "$STAMP" ]; then
  last=$(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP" 2>/dev/null || echo 0)
fi
[ $((now - last)) -lt "$TTL" ] && exit 0

# spawn の前に印を付ける —— 更新が失敗しても次の render がまた bun を起こさない
mkdir -p "$PAA_DIR" 2>/dev/null || exit 0
touch "$STAMP" 2>/dev/null || exit 0

# 背景で更新して即戻る(前景で待たない = 入力が固まらない)
nohup "$@" statusline --refresh >/dev/null 2>&1 &
exit 0
