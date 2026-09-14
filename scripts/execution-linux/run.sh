#!/usr/bin/env bash
set -euo pipefail

# Usage: CONTAINER_ENGINE=podman scripts/execution-linux/run.sh
# A ready Linux Docker/Podman engine is required; this does not create a VM.
engine="${CONTAINER_ENGINE:-podman}"
case "$engine" in podman|docker) ;; *) echo 'CONTAINER_ENGINE must be podman or docker' >&2; exit 2 ;; esac
command -v "$engine" >/dev/null
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
context_dir="$(mktemp -d "${TMPDIR:-/tmp}/station-linux-context.XXXXXX")"
trap 'rm -rf "$context_dir"' EXIT
mkdir -p "$context_dir/packages" "$context_dir/scripts/execution-linux"
cp "$repo_dir/tsconfig.base.json" "$context_dir/"
cp "$repo_dir/scripts/execution-linux/"* "$context_dir/scripts/execution-linux/"
for package in station-sandbox station-browser-use; do
  mkdir -p "$context_dir/packages/$package"
  cp "$repo_dir/packages/$package/package.json" "$repo_dir/packages/$package/tsconfig.json" "$context_dir/packages/$package/"
  cp -R "$repo_dir/packages/$package/src" "$repo_dir/packages/$package/test" "$context_dir/packages/$package/"
done
image_name="${STATION_LINUX_IMAGE:-station-execution-linux:local}"
"$engine" build --file "$context_dir/scripts/execution-linux/Containerfile" --tag "$image_name" "$context_dir"
# Build downloads dependencies. Runtime tests need only loopback: the custom npm
# package has no dependencies and is packed/installed locally with --offline.
"$engine" run --rm --init --network=none --shm-size=256m --memory=3g --cpus=2 "$image_name"
