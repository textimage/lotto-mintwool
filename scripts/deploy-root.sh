#!/bin/sh
# Shared validation for local callers, remote upload preflight, and release activation.
validate_deploy_root_name() {
  case "$1" in /*) ;; *) printf '%s\n' 'Application directory must be absolute' >&2; return 1;; esac
  case "$1" in *[!a-zA-Z0-9_/-]*) printf '%s\n' 'Invalid application directory' >&2; return 1;; esac
  validated_root="$(printf '%s' "$1" | sed 's#//*#/#g; s#/$##')"
  case "$validated_root" in
    ''|/opt|/home|/root|/tmp|/etc|/var|/usr)
      printf '%s\n' 'Choose a dedicated application directory' >&2; return 1;;
    /opt/mintwool/lotto) ;;
    /opt/mintwool|/opt/mintwool/*)
      printf '%s\n' 'Managed Lotto directory must be /opt/mintwool/lotto' >&2; return 1;;
  esac
  printf '%s\n' "$validated_root"
}

validate_deploy_root() {
  requested_root="$(validate_deploy_root_name "$1")" || return 1
  if [ "$requested_root" = /opt/mintwool/lotto ]; then
    for managed_parent in /opt /opt/mintwool /opt/mintwool/lotto; do
      [ ! -L "$managed_parent" ] || { printf '%s\n' 'Managed application directory must not contain symlinks' >&2; return 1; }
    done
  fi
  resolved_root="$(cd "$requested_root" && pwd -P)" || return 1
  validate_deploy_root_name "$resolved_root" >/dev/null || return 1
  if [ -d /opt/mintwool ]; then
    managed_physical="$(cd /opt/mintwool && pwd -P)" || return 1
    case "$resolved_root" in
      "$managed_physical"|"$managed_physical"/*)
        [ "$resolved_root" = /opt/mintwool/lotto ] && [ "$managed_physical" = /opt/mintwool ] || {
          printf '%s\n' 'Managed Lotto directory must be /opt/mintwool/lotto' >&2; return 1;
        };;
    esac
    # Canonicalization must not turn a symlink to a sibling app into a legacy root.
    for managed_app in /opt/mintwool/*; do
      [ -d "$managed_app" ] || continue
      app_physical="$(cd "$managed_app" && pwd -P)" || return 1
      case "$resolved_root" in
        "$app_physical"|"$app_physical"/*)
          [ "$managed_app" = /opt/mintwool/lotto ] && [ "$resolved_root" = /opt/mintwool/lotto ] || {
            printf '%s\n' 'Managed Lotto directory must be /opt/mintwool/lotto' >&2; return 1;
          };;
      esac
    done
  fi
  printf '%s\n' "$resolved_root"
}
