#!/usr/bin/env bash
# The acceptance fixture mutates /etc and /opt only inside disposable containers.
set -Eeuo pipefail
bundle=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
results=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mintwool-setup-tests.XXXXXXXX")
trap 'rm -f -- "$results"/*.Caddyfile; rmdir -- "$results"' EXIT
bash -n "$bundle/setup-server.sh"
bash -n "$bundle/tests/setup-server.test.sh"
for mode in both lotto tools; do
  for architecture in amd64 arm64; do
    docker run --rm --network none \
      --mount "type=bind,source=$bundle,target=/work,readonly" \
      --mount "type=bind,source=$results,target=/result" \
      -e MINTWOOL_FIXTURE=1 -e "FIXTURE_APP_MODE=$mode" -e "TEST_ARCH=$architecture" \
      node:24-bookworm-slim bash /work/tests/setup-server.test.sh
  done
done
docker run --rm --network none \
  --mount "type=bind,source=$results,target=/configs,readonly" \
  --entrypoint /bin/sh caddy:2.10.2-alpine -ec \
  'for config in /configs/*.Caddyfile; do caddy validate --config "$config" --adapter caddyfile; done'
