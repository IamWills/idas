#!/usr/bin/env bash
set -euo pipefail
dest="${1:?Pass an output directory}"
mkdir -p "$dest"
dest="$(cd "$dest" && pwd)"
for p in contracts core standard node react protocols; do
  pnpm --dir "packages/$p" pack --pack-destination "$dest"
done
