#!/usr/bin/env bash
# Publica site/ (já gerado localmente) no branch gh-pages do remote informado, sem histórico acumulado.
set -euo pipefail

remote="${1:-origin}"
cd "$(dirname "$0")"
test -f site/data/meta.json || { echo "rode 'uv run python -m pipeline all' antes" >&2; exit 1; }
url="$(git remote get-url "$remote")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp -r site/. "$tmp"
touch "$tmp/.nojekyll"
git -C "$tmp" init -q -b gh-pages
git -C "$tmp" add -A
git -C "$tmp" commit -q -m "chore: publica atlas eleitoral"
git -C "$tmp" push -f "$url" gh-pages
echo "publicado em gh-pages de $url"
