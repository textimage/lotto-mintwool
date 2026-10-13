#!/usr/bin/env bash
# Prepare a new Ubuntu 24.04 VM. Does not create OCI resources or deploy an app.
set -Eeuo pipefail
umask 077
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
email=''
app_user=${SUDO_USER:-ubuntu}
app_mode=''
lotto_domain=''
tools_domain=''
while (($#)); do
  case "$1" in
    --email) (($# >= 2)) || fail '--email needs a value'; email=$2; shift 2;;
    --user) (($# >= 2)) || fail '--user needs a value'; app_user=$2; shift 2;;
    --app) (($# >= 2)) || fail '--app needs a value'; app_mode=$2; shift 2;;
    --lotto-domain) (($# >= 2)) || fail '--lotto-domain needs a value'; lotto_domain=${2,,}; shift 2;;
    --tools-domain) (($# >= 2)) || fail '--tools-domain needs a value'; tools_domain=${2,,}; shift 2;;
    --help|-h)
      printf 'Usage: sudo bash setup-server.sh --app both --lotto-domain lotto.example.com --tools-domain tools.example.com --email owner@example.com [--user ubuntu]\n'
      printf '       sudo bash setup-server.sh --app lotto --lotto-domain lotto.example.com --email owner@example.com [--user ubuntu]\n'
      printf '       sudo bash setup-server.sh --app tools --tools-domain tools.example.com --email owner@example.com [--user ubuntu]\n'
      printf 'New Ubuntu 24.04 arm64/amd64 only. See README.md before running.\n'
      exit 0;;
    *) fail "Unknown option: $1";;
  esac
done
valid_domain() {
  local value=$1 label
  local -a labels
  [[ ${#value} -le 253 && "$value" == *.* && "$value" != *. && "$value" != *..* ]] || return 1
  [[ ! "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS=. read -r -a labels <<< "$value"
  for label in "${labels[@]}"; do
    [[ ${#label} -ge 1 && ${#label} -le 63 && "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
}
case "$app_mode" in
  both)
    valid_domain "$lotto_domain" || fail 'Supply a DNS name with --lotto-domain (without https:// or a port)'
    valid_domain "$tools_domain" || fail 'Supply a DNS name with --tools-domain (without https:// or a port)'
    [[ "$lotto_domain" != "$tools_domain" ]] || fail 'Lotto and Tools need different domain names';;
  lotto)
    valid_domain "$lotto_domain" || fail 'Supply a DNS name with --lotto-domain (without https:// or a port)'
    [[ -z "$tools_domain" ]] || fail 'Do not supply --tools-domain for --app lotto';;
  tools)
    valid_domain "$tools_domain" || fail 'Supply a DNS name with --tools-domain (without https:// or a port)'
    [[ -z "$lotto_domain" ]] || fail 'Do not supply --lotto-domain for --app tools';;
  *) fail 'Supply --app both, lotto, or tools';;
esac
[[ "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] || fail 'Supply your certificate email with --email'
[[ "$app_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$app_user" != root ]] || fail 'Use a non-root deployment user'
((EUID == 0)) || fail 'Run this script with sudo'
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail 'This setup supports Ubuntu 24.04 only'
architecture=$(dpkg --print-architecture)
[[ "$architecture" == arm64 || "$architecture" == amd64 ]] || fail 'Use Ubuntu arm64 or amd64'
app_user_home=$(getent passwd "$app_user" | cut -d: -f6)
app_group=$(id -gn "$app_user")
[[ "$app_user_home" == /home/* && -d "$app_user_home" && ! -L "$app_user_home" ]] || fail 'The deployment user must have a real home under /home'
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
[[ -f "$script_dir/Caddyfile" && ! -L "$script_dir/Caddyfile" ]] || fail 'Put a regular Caddyfile beside this script'
state_dir=/opt/mintwool
lotto_dir=$state_dir/lotto
tools_dir=$state_dir/tools
marker=$state_dir/.setup-managed
config_record=$state_dir/.setup-config
config_identity=$(printf 'APP=%s\nLOTTO_DOMAIN=%s\nTOOLS_DOMAIN=%s\nUSER=%s' "$app_mode" "$lotto_domain" "$tools_domain" "$app_user")
[[ ! -L /opt && ! -L "$state_dir" && ! -L "$lotto_dir" && ! -L "$tools_dir" && ! -L /opt/lotto-note && ! -L "$app_user_home/doguham" ]] || fail 'Application directories must not be symlinks'
[[ ! -L "$marker" && ! -L "$config_record" && ! -L "$tools_dir/.env" && ! -L "$state_dir/deploy.lock" && ! -L /etc/caddy && ! -L /etc/caddy/Caddyfile ]] || fail 'Managed configuration paths must not be symlinks'
for legacy_dir in /opt/lotto-note "$app_user_home/doguham"; do
  if [[ -e "$legacy_dir" ]]; then
    fail "Legacy application path exists: $legacy_dir. This installer needs fresh app directories; review the existing deployment first. No package or service changes were made"
  fi
done
managed=0
if [[ -f "$marker" && "$(cat "$marker")" == mintwool-oci-v1 ]]; then managed=1; fi
if [[ -e "$config_record" ]]; then
  [[ -f "$config_record" && "$(cat "$config_record")" == "$config_identity" ]] || fail 'Saved installation mode, domains or user differ. Use the domain-change procedure in README.md; no changes were made'
fi
if ((managed)) && [[ ! -e "$config_record" && -f /etc/caddy/Caddyfile ]]; then
  # Recognize the previous shared-server installer without replacing another site's config.
  [[ "$app_mode" == both ]] && grep -Fxq "$lotto_domain {" /etc/caddy/Caddyfile && grep -Fxq "$tools_domain {" /etc/caddy/Caddyfile || fail 'Existing managed Caddy sites differ; review the running server before setup'
fi
if (( ! managed )) && [[ -e /etc/caddy/Caddyfile ]]; then
  fail 'An unmanaged Caddy configuration exists; review it before using this new-server setup'
fi
listeners=$(ss -H -lntp '( sport = :80 or sport = :443 )')
if [[ -n "$listeners" ]]; then
  ((managed)) || fail 'Port 80 or 443 is already used; existing services were not stopped'
  while IFS= read -r listener; do
    [[ "$listener" == *'("caddy",'* ]] || fail 'Another service owns a web port; it was not stopped'
  done <<< "$listeners"
fi
if (( ! managed )); then
  for directory in "$state_dir" "$lotto_dir" "$tools_dir"; do
    if [[ -d "$directory" && -n "$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      fail "Existing application directory needs review: $directory"
    fi
  done
fi
work=$(mktemp -d /tmp/mintwool-setup.XXXXXXXX)
cleanup() {
  rm -f -- "$work/docker.asc" "$work/caddy.key" "$work/caddy.gpg" "$work/caddy.list" "$work/docker.sources" "$work/Caddyfile" "$work/web-ports.service"
  rmdir -- "$work"
}
trap cleanup EXIT
install -d -m 700 -o "$app_user" -g "$app_group" "$state_dir"
if [[ "$app_mode" != tools ]]; then install -d -m 700 -o "$app_user" -g "$app_group" "$lotto_dir"; fi
if [[ "$app_mode" != lotto ]]; then install -d -m 700 -o "$app_user" -g "$app_group" "$tools_dir"; fi
printf 'mintwool-oci-v1\n' > "$marker"
chmod 600 "$marker"
chown "$app_user:$app_group" "$marker"
printf '%s\n' "$config_identity" > "$config_record"
chmod 600 "$config_record"
chown "$app_user:$app_group" "$config_record"
printf '[setup] Preparing Docker and Caddy from their official repositories...\n'
if command -v docker >/dev/null; then
  docker compose version >/dev/null || fail 'Existing Docker has no Compose plugin; review it manually'
  docker info >/dev/null || fail 'Existing Docker is not running; review it manually'
else
  for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    [[ "$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)" != installed ]] || fail "Existing package $package needs review; it was not removed"
  done
  apt-get update
  apt-get install -y ca-certificates curl
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$work/docker.asc"
  install -m 0644 "$work/docker.asc" /etc/apt/keyrings/docker.asc
  printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$architecture" > "$work/docker.sources"
  install -m 0644 "$work/docker.sources" /etc/apt/sources.list.d/docker.sources
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
usermod -aG docker "$app_user"
apt-get install -y ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https util-linux iptables
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$work/caddy.key"
  gpg --batch --yes --dearmor --output "$work/caddy.gpg" "$work/caddy.key"
  install -m 0644 "$work/caddy.gpg" /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o "$work/caddy.list"
  install -m 0644 "$work/caddy.list" /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
# Keep SSH and Docker firewall chains; only add the public web ports, also on reboot.
cat > "$work/web-ports.service" <<'UNIT'
[Unit]
Description=Allow mintwool HTTP HTTPS and HTTP3 ports
After=network-pre.target
Before=caddy.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c '/usr/sbin/iptables -w -C INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT || /usr/sbin/iptables -w -I INPUT 1 -p tcp -m multiport --dports 80,443 -j ACCEPT'
ExecStart=/bin/sh -c '/usr/sbin/iptables -w -C INPUT -p udp --dport 443 -j ACCEPT || /usr/sbin/iptables -w -I INPUT 1 -p udp --dport 443 -j ACCEPT'

[Install]
WantedBy=multi-user.target
UNIT
install -m 0644 "$work/web-ports.service" /etc/systemd/system/mintwool-web-ports.service
systemctl daemon-reload
systemctl enable mintwool-web-ports.service
systemctl restart mintwool-web-ports.service
if [[ ! -e "$state_dir/deploy.lock" ]]; then
  install -m 0600 -o "$app_user" -g "$app_group" /dev/null "$state_dir/deploy.lock"
fi
[[ -f "$state_dir/deploy.lock" && ! -L "$state_dir/deploy.lock" ]] || fail 'Invalid shared deployment lock'
if [[ "$app_mode" != lotto && ! -e "$tools_dir/.env" ]]; then
  printf 'DOMAIN=%s\nACME_EMAIL=%s\nAPP_PORT=3001\nJOB_CONCURRENCY=1\n' "$tools_domain" "$email" > "$tools_dir/.env"
  chmod 600 "$tools_dir/.env"
  chown "$app_user:$app_group" "$tools_dir/.env"
fi
# Only render the selected app blocks, including the Tools WebSocket CSP origin.
APP_VALUE="$app_mode" EMAIL_VALUE="$email" LOTTO_VALUE="$lotto_domain" TOOLS_VALUE="$tools_domain" awk '
  BEGIN { enabled = 1 }
  /^# BEGIN LOTTO$/ { enabled = ENVIRON["APP_VALUE"] != "tools"; next }
  /^# BEGIN TOOLS$/ { enabled = ENVIRON["APP_VALUE"] != "lotto"; next }
  /^# END (LOTTO|TOOLS)$/ { enabled = 1; next }
  enabled {
    gsub(/__ACME_EMAIL__/, ENVIRON["EMAIL_VALUE"])
    gsub(/__LOTTO_DOMAIN__/, ENVIRON["LOTTO_VALUE"])
    gsub(/__TOOLS_DOMAIN__/, ENVIRON["TOOLS_VALUE"])
    print
  }
' "$script_dir/Caddyfile" > "$work/Caddyfile"
if grep -Eq '__[A-Z_]+__' "$work/Caddyfile"; then fail 'Unresolved Caddyfile template value'; fi
caddy validate --config "$work/Caddyfile" --adapter caddyfile
backup=''
install -d -m 0755 /etc/caddy
if [[ -f /etc/caddy/Caddyfile ]]; then
  backup="/etc/caddy/Caddyfile.before-mintwool-$(date -u +%Y%m%d%H%M%S)-$$"
  cp -p -- /etc/caddy/Caddyfile "$backup"
fi
install -m 0644 "$work/Caddyfile" /etc/caddy/Caddyfile
systemctl enable caddy
if systemctl is-active --quiet caddy; then command=reload; else command=start; fi
if ! systemctl "$command" caddy; then
  if [[ -n "$backup" ]]; then
    cp -p -- "$backup" /etc/caddy/Caddyfile
    systemctl restart caddy || true
  fi
  fail 'Caddy activation failed; the prior configuration was restored when available'
fi
docker compose version
printf '\n[setup] Ready. Reconnect SSH to activate the Docker group membership.\n'
printf 'Shared Caddy: /etc/caddy/Caddyfile\nDeployment lock: /opt/mintwool/deploy.lock\n'
if [[ "$app_mode" != tools ]]; then printf 'Lotto: /opt/mintwool/lotto -> https://%s\n' "$lotto_domain"; fi
if [[ "$app_mode" != lotto ]]; then printf 'Tools: /opt/mintwool/tools -> https://%s\n' "$tools_domain"; fi
printf 'Continue with the GitHub settings in README.md. A 502 response is expected until the apps are deployed.\n'
