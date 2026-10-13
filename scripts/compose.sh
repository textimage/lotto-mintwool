#!/bin/sh
# Use the image and domain recorded for this release for routine server operations.
set -eu
directory="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$directory"
if [ -f .release-domain ]; then
  APP_DOMAIN="$(cat .release-domain)"
  APP_IMAGE="lotto-note:$(basename "$directory")"
  export APP_DOMAIN APP_IMAGE
fi
unset COMPOSE_FILE COMPOSE_PROJECT_NAME
exec docker compose --project-name lotto-note --env-file "$directory/.env" -f "$directory/compose.yaml" "$@"
