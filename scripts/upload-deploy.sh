#!/usr/bin/env bash
# GitHub-hosted runner entrypoint. Secrets are passed as environment variables.
set -euo pipefail
umask 077
: "${OCI_HOST:?Set OCI_HOST}"
: "${OCI_USERNAME:?Set OCI_USERNAME}"
: "${OCI_SSH_PRIVATE_KEY:?Set OCI_SSH_PRIVATE_KEY}"
: "${OCI_SSH_KNOWN_HOSTS:?Set OCI_SSH_KNOWN_HOSTS}"
: "${RELEASE_ID:?Set RELEASE_ID}"
port="${OCI_SSH_PORT:-22}"
root="${OCI_DEPLOY_DIR:-/opt/mintwool/lotto}"
domain="${APP_DOMAIN:-lotto.mintwool.com}"
proxy="${OCI_PROXY_MODE:-existing}"
shared_lock="${OCI_DEPLOY_LOCK_FILE:-}"
[[ "$OCI_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || { echo 'Invalid SSH host' >&2; exit 1; }
[[ "$OCI_USERNAME" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || { echo 'Invalid SSH user' >&2; exit 1; }
[[ "$port" =~ ^[0-9]+$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || { echo 'Invalid SSH port' >&2; exit 1; }
source "$(dirname "${BASH_SOURCE[0]}")/deploy-root.sh"
root="$(validate_deploy_root_name "$root")" || exit 1
[[ "$domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid domain' >&2; exit 1; }
[[ "$RELEASE_ID" =~ ^[a-z0-9][a-z0-9-]{0,99}$ ]] || { echo 'Invalid release ID' >&2; exit 1; }
case "$proxy" in caddy|existing) ;; *) echo 'Invalid proxy mode' >&2; exit 1;; esac
if [[ -n "$shared_lock" ]]; then
  [[ "$shared_lock" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Invalid shared deployment lock' >&2; exit 1; }
  case "$shared_lock" in */../*|*/..|*/./*|*/.|*/|*//*) echo 'Invalid shared deployment lock' >&2; exit 1;; esac
fi
project="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
root_validation="$(cat "$project/scripts/deploy-root.sh")"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lotto-upload.XXXXXXXX")"
cleanup() {
  rm -f "$work/key" "$work/known_hosts" "$work/.env.bootstrap" "$work/source.tar.gz"
  rmdir "$work"
}
trap cleanup EXIT
printf '%s\n' "$OCI_SSH_PRIVATE_KEY" | tr -d '\r' > "$work/key"
printf '%s\n' "$OCI_SSH_KNOWN_HOSTS" | tr -d '\r' > "$work/known_hosts"
chmod 600 "$work/key" "$work/known_hosts"
ssh_options=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes
  -o "UserKnownHostsFile=$work/known_hosts" -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -i "$work/key")
target="$OCI_USERNAME@$OCI_HOST"
remote="$root/releases/$RELEASE_ID"
sources=(package.json package-lock.json tsconfig.json tsconfig.server.json vite.config.ts index.html Dockerfile
  compose.yaml Caddyfile .dockerignore .env.example README.md src shared server scripts tests public)
tar -czf "$work/source.tar.gz" -C "$project" "${sources[@]}"
ssh "${ssh_options[@]}" -p "$port" "$target" "set -eu; umask 077
$root_validation
validate_deploy_root '$root' >/dev/null
docker compose version >/dev/null
mkdir -p '$root/releases'
mkdir '$remote'"
scp "${ssh_options[@]}" -P "$port" "$work/source.tar.gz" "$target:$remote/source.tar.gz"
if [[ -n "${OCI_ENV_BOOTSTRAP:-}" ]]; then
  printf '%s\n' "$OCI_ENV_BOOTSTRAP" > "$work/.env.bootstrap"
  scp "${ssh_options[@]}" -P "$port" "$work/.env.bootstrap" "$target:$remote/.env.bootstrap"
fi
ssh "${ssh_options[@]}" -p "$port" "$target" \
  "set -eu; cd '$remote'; tar -xzf source.tar.gz --no-same-owner; rm -f source.tar.gz; sh scripts/deploy.sh '$domain' '$proxy' '$root' '$RELEASE_ID' '$shared_lock'"
