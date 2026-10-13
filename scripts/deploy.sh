#!/bin/sh
# Run from an uploaded release directory. Both Actions and deploy.ps1 use this entrypoint.
set -eu
umask 077
domain="${1:-lotto.mintwool.com}"
proxy="${2:-caddy}"
root="${3:-/opt/mintwool/lotto}"
release_id="${4:-}"
shared_lock="${5:-}"
fail() { printf '%s\n' "$*" >&2; exit 1; }
case "$domain" in ''|*[!a-zA-Z0-9.-]*|.*|-*) fail 'Invalid domain';; esac
case "$proxy" in caddy|existing) ;; *) fail 'Invalid proxy mode';; esac
case "$release_id" in ''|*[!a-z0-9-]*) fail 'Invalid release ID';; esac
[ "${#release_id}" -le 100 ] || fail 'Release ID is too long'
. "$(dirname "$0")/deploy-root.sh"
root="$(validate_deploy_root "$root")" || exit 1
release_dir="$root/releases/$release_id"
[ "$(pwd -P)" = "$release_dir" ] || fail 'Run from the matching release directory'
test -f compose.yaml && test -f Dockerfile || fail 'Release source is incomplete'
command -v flock >/dev/null || fail 'flock is required'
if [ -n "$shared_lock" ]; then
  case "$shared_lock" in /*) ;; *) fail 'Shared deployment lock must be absolute';; esac
  case "$shared_lock" in *[!a-zA-Z0-9_./-]*|*/../*|*/..|*/./*|*/.|*/|*//*) fail 'Invalid shared deployment lock';; esac
  [ -f "$shared_lock" ] && [ ! -L "$shared_lock" ] || fail 'Prepare the shared deployment lock with OCI/setup-server.sh first'
  exec 8<>"$shared_lock"
  printf 'Waiting for shared server deployment lock (up to 15 minutes)...\n'
  flock -w 900 8 || fail 'Timed out waiting for another application deployment'
fi
exec 9>"$root/.deploy.lock"
flock -n 9 || fail 'Another deployment is running'

if [ ! -f "$root/.env" ]; then
  test -s .env.bootstrap || fail 'Configure OCI_ENV_BOOTSTRAP for the first deployment'
  # Copy first so a partial write can never become the active configuration.
  cp .env.bootstrap "$root/.env.initial-$release_id"
  chmod 600 "$root/.env.initial-$release_id"
  mv "$root/.env.initial-$release_id" "$root/.env"
fi
rm -f .env.bootstrap
chmod 600 "$root/.env"
ln -s "$root/.env" .env
printf '%s\n' "$domain" > .release-domain
printf '%s\n' "$proxy" > .release-proxy
export APP_DOMAIN="$domain" APP_IMAGE="lotto-note:$release_id"
unset COMPOSE_FILE COMPOSE_PROJECT_NAME

compose() {
  docker compose --project-name lotto-note --env-file "$root/.env" -f "$release_dir/compose.yaml" "$@"
}
previous_dir=''
previous_id=''
previous_domain=''
previous_proxy=''
if [ -L "$root/current" ]; then
  previous_dir="$(readlink -f "$root/current")"
  previous_id="$(basename "$previous_dir")"
  case "$previous_id" in ''|*[!a-z0-9-]*) fail 'Invalid previous release ID';; esac
  [ "$previous_dir" = "$root/releases/$previous_id" ] || fail 'Previous release is outside the application directory'
  [ "$previous_id" != "$release_id" ] || fail 'Release is already active'
  previous_domain="$(cat "$previous_dir/.release-domain")"
  previous_proxy="$(cat "$previous_dir/.release-proxy")"
  case "$previous_domain" in ''|*[!a-zA-Z0-9.-]*) fail 'Invalid previous domain';; esac
  case "$previous_proxy" in caddy|existing) ;; *) fail 'Invalid previous proxy mode';; esac
elif [ -e "$root/current" ]; then
  fail 'current must be a managed release symlink'
fi
previous_compose() {
  APP_DOMAIN="$previous_domain" APP_IMAGE="lotto-note:$previous_id" docker compose \
    --project-name lotto-note --env-file "$root/.env" -f "$previous_dir/compose.yaml" "$@"
}
running="$(compose ps --status running --services)"
was_running=0
if printf '%s\n' "$running" | grep -qx app; then
  [ -n "$previous_dir" ] || fail 'Existing app has no managed release record. Preserve its configuration before converting it.'
  was_running=1
fi
stage=prepare
stopped=0
migration_attempted=0
app_started=0
snapshot_ok=0
backup="/app/backups/deploy-$release_id.sqlite"
maintenance_container="lotto-note-maintenance-$release_id"
event() { printf 'event=%s stage=%s release=%s backup=%s\n' "$1" "$stage" "$release_id" "$backup"; }
maintenance() {
  compose run --rm --no-deps -T --name "$maintenance_container" app node dist/server/server/maintenance.js "$@"
}
check_health() {
  active_id="$(compose ps -q app)"
  [ -n "$active_id" ] || return 1
  binding="$(compose port app 3000)"
  case "$binding" in 127.0.0.1:[0-9]*) ;; *) return 1;; esac
  attempt=0
  until [ "$(docker inspect --format '{{.State.Health.Status}}' "$active_id")" = healthy ] && \
    curl --fail --silent --show-error --connect-timeout 5 --max-time 10 "http://$binding/healthz" >/dev/null; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 30 ] || return 1
    sleep 2
  done
}
resume_previous() {
  [ "$was_running" -eq 1 ] || return 0
  previous_compose up -d --no-build --pull never app || return 1
  recovered="$(previous_compose ps -q app)"
  recovered_binding="$(previous_compose port app 3000)"
  case "$recovered_binding" in 127.0.0.1:[0-9]*) ;; *) return 1;; esac
  attempt=0
  until [ -n "$recovered" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$recovered")" = healthy ] && \
    curl --fail --silent --show-error --connect-timeout 5 --max-time 10 "http://$recovered_binding/healthz" >/dev/null; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 30 ] || return 1
    sleep 2
  done
  curl --fail --silent --show-error --connect-timeout 5 --max-time 15 --retry 3 --retry-delay 2 "https://$previous_domain/healthz" >/dev/null
}
on_exit() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$result" -ne 0 ]; then
    set +e
    event deployment_failed >&2
    # Stop a one-off container before restoring a DB after an interrupted SSH session.
    docker rm -f "$maintenance_container" >/dev/null 2>&1
    if [ "$app_started" -eq 1 ]; then
      compose stop app
      compose logs --tail=60 app >&2
      event database_preserved >&2
    elif [ "$migration_attempted" -eq 1 ]; then
      if [ "$snapshot_ok" -eq 1 ]; then
        if maintenance restore "$backup" && resume_previous; then
          event rollback_completed >&2
        else
          event rollback_failed >&2
        fi
      else
        event first_deployment_database_preserved >&2
      fi
    elif [ "$stopped" -eq 1 ]; then
      if resume_previous; then event previous_app_resumed >&2; else event rollback_failed >&2; fi
    fi
  fi
  exit "$result"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

stage=build
event deployment_started
compose config --quiet
if [ -n "$previous_dir" ]; then
  docker image inspect "lotto-note:$previous_id" >/dev/null
fi
compose build app
if [ "$proxy" = caddy ]; then compose pull caddy; fi
stage=qr_check
compose run --rm --no-deps -T --name "$maintenance_container" app node dist/server/scripts/telegram-qr-check.js
stage=stop
# Set before stopping: a partial stop also requires the previous app to resume.
stopped=1
compose stop app
stage=snapshot
snapshot_status=0
maintenance snapshot "$backup" || snapshot_status=$?
case "$snapshot_status" in
  0) snapshot_ok=1;;
  3) [ -z "$previous_dir" ] || fail 'Database missing for an existing release';;
  *) fail 'Final database snapshot failed';;
esac
stage=migrate
migration_attempted=1
maintenance migrate
stage=start
# From this point the app can create records or send Telegram messages.
app_started=1
if [ "$proxy" = existing ]; then compose up -d --no-build --pull never app; else compose up -d --no-build --pull never; fi
stage=health
check_health
if [ "$proxy" = caddy ]; then
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
fi
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 --retry 6 --retry-delay 5 "https://$domain/healthz" >/dev/null
stage=commit
docker image tag "lotto-note:$release_id" lotto-note:local
if [ -n "$previous_dir" ]; then
  ln -s "releases/$previous_id" "$root/.previous-$release_id"
  mv -Tf "$root/.previous-$release_id" "$root/previous"
fi
ln -s "releases/$release_id" "$root/.current-$release_id"
mv -Tf "$root/.current-$release_id" "$root/current"
stage=complete
event deployment_completed
