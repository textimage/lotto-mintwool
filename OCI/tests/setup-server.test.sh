#!/usr/bin/env bash
# Acceptance fixture. Must only run inside a disposable Docker container.
set -Eeuo pipefail
[[ -f /.dockerenv && "${MINTWOOL_FIXTURE:-}" == 1 ]] || exit 95
mkdir -p /fixture/bin /etc/caddy
touch /fixture/calls
printf 'ID=ubuntu\nVERSION_ID=24.04\n' > /etc/os-release
cat > /fixture/bin/command-fixture <<'MOCK'
#!/usr/bin/env bash
set -eu
name=$(basename "$0")
if [[ "$name" != dpkg ]]; then printf '%s %s\n' "$name" "$*" >> /fixture/calls; fi
case "$name" in
  apt-get|usermod) exit 0;;
  docker) printf 'Docker Compose fixture\n';;
  dpkg) [[ "$1" == --print-architecture ]]; printf '%s\n' "${TEST_ARCH:-amd64}";;
  ss)
    if [[ "${TEST_LISTENER:-}" == nginx ]]; then printf 'LISTEN 0 4096 *:80 *:* users:(("nginx",pid=1,fd=3))\n';
    elif [[ "${TEST_LISTENER:-}" == caddy ]]; then printf 'LISTEN 0 4096 *:80 *:* users:(("caddy",pid=1,fd=3))\n'; fi;;
  caddy) [[ "${TEST_BAD_CADDY:-0}" == 0 ]];;
  systemctl)
    if [[ "$1" == is-active ]]; then [[ -f /fixture/caddy-active ]];
    elif [[ "$1" == reload && "${TEST_FAIL_RELOAD:-0}" == 1 ]]; then exit 1;
    elif [[ "$1" == start || "$1" == restart ]]; then touch /fixture/caddy-active; fi;;
  *) exit 96;;
esac
MOCK
chmod 755 /fixture/bin/command-fixture
for command_name in docker ss caddy systemctl apt-get usermod dpkg; do
  ln -s command-fixture "/fixture/bin/$command_name"
done
export PATH="/fixture/bin:$PATH"
fixture_mode=${FIXTURE_APP_MODE:-both}
case "$fixture_mode" in
  both) domain_args=(--lotto-domain LOTTO.example.net --tools-domain tools.example.org); primary_flag=--lotto-domain;;
  lotto) domain_args=(--lotto-domain LOTTO.example.net); primary_flag=--lotto-domain;;
  tools) domain_args=(--tools-domain tools.example.org); primary_flag=--tools-domain;;
  *) exit 95;;
esac
setup() { bash /work/setup-server.sh --app "$fixture_mode" "${domain_args[@]}" --email "${1:-owner@example.com}" --user node "${@:2}" > /fixture/output 2>&1; }

if bash /work/setup-server.sh --email owner@example.com --user node > /fixture/output 2>&1; then exit 1; fi
[[ ! -e /opt/mintwool ]]
printf 'PASS installation mode must be explicit\n'

for bad_domain in 'https://lotto.example.net' 'example..net' '-bad.example.net' 'bad_.example.net' '203.0.113.10' 'example.net:443' 'example.net;touch /tmp/injected' '*.example.net' "$(printf '%064d' 1).example.net"; do
  if setup owner@example.com "$primary_flag" "$bad_domain"; then exit 1; fi
  [[ ! -e /opt/mintwool && ! -e /tmp/injected ]]
done
if [[ "$fixture_mode" == both ]]; then
  if setup owner@example.com --lotto-domain tools.example.org; then exit 1; fi
elif [[ "$fixture_mode" == lotto ]]; then
  if setup owner@example.com --tools-domain tools.example.org; then exit 1; fi
else
  if setup owner@example.com --lotto-domain lotto.example.net; then exit 1; fi
fi
[[ ! -e /opt/mintwool ]]
printf 'PASS malformed, duplicate and unselected domains are rejected before changes\n'

original_arch=${TEST_ARCH:-amd64}
export TEST_ARCH=armhf
if setup; then exit 1; fi
[[ ! -e /opt/mintwool ]]
export TEST_ARCH=$original_arch
printf 'ID=ubuntu\nVERSION_ID=22.04\n' > /etc/os-release
if setup; then exit 1; fi
[[ ! -e /opt/mintwool ]]
printf 'ID=ubuntu\nVERSION_ID=24.04\n' > /etc/os-release
printf 'PASS unsupported OS and architecture are rejected before changes\n'

if setup invalid-email; then exit 1; fi
[[ ! -e /opt/mintwool ]]
printf 'PASS invalid input does not prepare system directories\n'

export TEST_LISTENER=nginx
if setup; then exit 1; fi
grep -q 'Port 80 or 443 is already used' /fixture/output
[[ ! -e /opt/mintwool ]]
unset TEST_LISTENER
printf 'PASS an existing web service is left untouched\n'

printf 'original unmanaged config\n' > /etc/caddy/Caddyfile
if setup; then exit 1; fi
grep -q 'unmanaged Caddy configuration' /fixture/output
grep -q 'original unmanaged config' /etc/caddy/Caddyfile
rm -f /etc/caddy/Caddyfile
printf 'PASS an unmanaged Caddy configuration is preserved\n'

for legacy_dir in /opt/lotto-note /home/node/doguham; do
  mkdir -p "$legacy_dir"
  printf 'legacy-env-preserved\n' > "$legacy_dir/.env"
  calls_digest=$(sha256sum /fixture/calls)
  if setup; then exit 1; fi
  grep -q 'This installer needs fresh app directories' /fixture/output
  [[ "$calls_digest" == "$(sha256sum /fixture/calls)" ]]
  [[ ! -e /opt/mintwool ]]
  grep -q legacy-env-preserved "$legacy_dir/.env"
  rm -f "$legacy_dir/.env"
  rmdir "$legacy_dir"
done
printf 'PASS legacy app paths require migration before package or service changes\n'

mkdir -p /opt/lotto-note
calls_digest=$(sha256sum /fixture/calls)
if setup; then exit 1; fi
grep -q 'Legacy application path exists' /fixture/output
[[ "$calls_digest" == "$(sha256sum /fixture/calls)" ]]
[[ ! -e /opt/mintwool ]]
rmdir /opt/lotto-note
printf 'PASS even an empty legacy app path requires migration\n'

ln -s /fixture /opt/mintwool
calls_digest=$(sha256sum /fixture/calls)
if setup; then exit 1; fi
grep -q 'Application directories must not be symlinks' /fixture/output
[[ "$calls_digest" == "$(sha256sum /fixture/calls)" ]]
rm -f /opt/mintwool
printf 'PASS a symlinked application root is rejected before mutations\n'

setup || { cat /fixture/output; exit 1; }
grep -q 'email owner@example.com' /etc/caddy/Caddyfile
if [[ "$fixture_mode" != tools ]]; then
  [[ -d /opt/mintwool/lotto ]]
  grep -Fxq 'lotto.example.net {' /etc/caddy/Caddyfile
else
  [[ ! -e /opt/mintwool/lotto ]]
  ! grep -q 'lotto.example.net\|127.0.0.1:3000' /etc/caddy/Caddyfile
fi
if [[ "$fixture_mode" != lotto ]]; then
  [[ -d /opt/mintwool/tools ]]
  grep -Fxq 'tools.example.org {' /etc/caddy/Caddyfile
  grep -q 'wss://tools.example.org' /etc/caddy/Caddyfile
  grep -Fxq 'DOMAIN=tools.example.org' /opt/mintwool/tools/.env
  grep -q 'JOB_CONCURRENCY=1' /opt/mintwool/tools/.env
  [[ "$(stat -c %a /opt/mintwool/tools/.env)" == 600 ]]
  [[ "$(stat -c %u /opt/mintwool/tools/.env)" == 1000 ]]
else
  [[ ! -e /opt/mintwool/tools ]]
  ! grep -q 'tools.example.org\|127.0.0.1:3001' /etc/caddy/Caddyfile
fi
! grep -Eq '__[A-Z_]+__|mintwool.com' /etc/caddy/Caddyfile
[[ ! -e /opt/lotto-note && ! -e /home/node/doguham ]]
[[ "$(stat -c %a /opt/mintwool/deploy.lock)" == 600 ]]
[[ "$(stat -c %u /opt/mintwool/deploy.lock)" == 1000 ]]
[[ -f /opt/mintwool/.setup-config && "$(stat -c %a /opt/mintwool/.setup-config)" == 600 ]]
printf 'PASS selected app roots, domains and WebSocket origin are configured together\n'

if [[ "$fixture_mode" != lotto ]]; then
  printf 'OPENAI_API_KEY=fixture-only\n' >> /opt/mintwool/tools/.env
  env_digest=$(sha256sum /opt/mintwool/tools/.env)
fi
lock_inode=$(stat -c %i /opt/mintwool/deploy.lock)
printf 'existing-lock-content\n' > /opt/mintwool/deploy.lock
export TEST_LISTENER=caddy
setup || { cat /fixture/output; exit 1; }
if [[ "$fixture_mode" != lotto ]]; then [[ "$env_digest" == "$(sha256sum /opt/mintwool/tools/.env)" ]]; fi
[[ "$lock_inode" == "$(stat -c %i /opt/mintwool/deploy.lock)" ]]
grep -q existing-lock-content /opt/mintwool/deploy.lock
printf 'PASS repeated setup preserves app settings and the lock inode\n'

config_digest=$(sha256sum /etc/caddy/Caddyfile)
record_digest=$(sha256sum /opt/mintwool/.setup-config)
calls_digest=$(sha256sum /fixture/calls)
if setup owner@example.com "$primary_flag" changed.example.org; then exit 1; fi
grep -q 'Saved installation mode, domains or user differ' /fixture/output
[[ "$config_digest" == "$(sha256sum /etc/caddy/Caddyfile)" ]]
[[ "$record_digest" == "$(sha256sum /opt/mintwool/.setup-config)" ]]
[[ "$calls_digest" == "$(sha256sum /fixture/calls)" ]]
printf 'PASS rerunning with different domains cannot overwrite a running installation\n'

for app_dir in /opt/mintwool/lotto /opt/mintwool/tools; do
  [[ -d "$app_dir" ]] || continue
  mv "$app_dir" /fixture/app-preserved
  ln -s /fixture/app-preserved "$app_dir"
  calls_digest=$(sha256sum /fixture/calls)
  if setup; then exit 1; fi
  grep -q 'Application directories must not be symlinks' /fixture/output
  [[ "$calls_digest" == "$(sha256sum /fixture/calls)" ]]
  rm -f "$app_dir"
  mv /fixture/app-preserved "$app_dir"
done
printf 'PASS symlinked Lotto and Tools directories are rejected before mutations\n'

if [[ "$fixture_mode" != lotto ]]; then
mv /opt/mintwool/tools/.env /fixture/env-preserved
ln -s /fixture/env-preserved /opt/mintwool/tools/.env
calls_digest=$(sha256sum /fixture/calls)
if setup; then exit 1; fi
grep -q 'Managed configuration paths must not be symlinks' /fixture/output
[[ "$calls_digest" == "$(sha256sum /fixture/calls)" ]]
rm -f /opt/mintwool/tools/.env
mv /fixture/env-preserved /opt/mintwool/tools/.env
[[ "$env_digest" == "$(sha256sum /opt/mintwool/tools/.env)" ]]
printf 'PASS a symlinked Tools env is rejected without modifying settings\n'
fi

mv /opt/mintwool/.setup-config /fixture/config-preserved
ln -s /fixture/config-preserved /opt/mintwool/.setup-config
calls_digest=$(sha256sum /fixture/calls)
if setup; then exit 1; fi
[[ "$calls_digest" == "$(sha256sum /fixture/calls)" ]]
rm -f /opt/mintwool/.setup-config
mv /fixture/config-preserved /opt/mintwool/.setup-config
printf 'PASS a symlinked installation record is rejected before changes\n'

config_digest=$(sha256sum /etc/caddy/Caddyfile)
export TEST_BAD_CADDY=1
if setup next@example.com; then exit 1; fi
[[ "$config_digest" == "$(sha256sum /etc/caddy/Caddyfile)" ]]
unset TEST_BAD_CADDY
printf 'PASS invalid replacement config never overwrites the active config\n'

export TEST_FAIL_RELOAD=1
if setup next@example.com; then exit 1; fi
[[ "$config_digest" == "$(sha256sum /etc/caddy/Caddyfile)" ]]
grep -q 'prior configuration was restored' /fixture/output
printf 'PASS failed Caddy reload restores the prior configuration\n'
if [[ -d /result ]]; then cp /etc/caddy/Caddyfile "/result/${fixture_mode}-${original_arch}.Caddyfile"; fi
printf 'PASS complete: %s %s\n' "$fixture_mode" "$original_arch"
