# 로또 6/45 운영 안내

`lotto.mintwool.com`에서 운영하는 개인 로또 기록장입니다. 초기 계정 하나를 사용하며, 구매 기록·QR 등록·당첨 대조·번호 통계·생성·동기화·백업을 제공합니다.

## 설치와 환경설정

소스 빌드에는 Node.js 24 LTS가 필요합니다. 운영 서버는 Docker Engine, Docker Compose v2, curl, tar, flock(util-linux)을 갖춘 Linux VM을 사용하며, 배포 사용자는 `sudo` 없이 Docker를 실행할 수 있어야 합니다.

설정 항목은 [.env.example](.env.example)을 참고해 `.env`에 작성합니다. 초기 계정의 암호 해시는 다음 명령으로 생성합니다.

```powershell
npm.cmd ci
npm.cmd run setup:admin
```

비밀번호 입력은 숨겨지고 `.env`에는 scrypt 해시만 저장됩니다. `BOOTSTRAP_PASSWORD_HASH='scrypt$…'`의 작은따옴표를 유지해야 Compose가 `$`를 문자 그대로 읽습니다. 계정이 이미 있는 DB는 설정 스크립트나 재배포로 비밀번호가 초기화되지 않습니다. `.env`, DB, 백업은 Git과 Docker 이미지에서 제외됩니다.

| 환경변수 | 용도와 설정 방법 |
|---|---|
| `APP_DOMAIN` | 기본값 `lotto.mintwool.com`. 자동 배포에서는 GitHub Variable `APP_DOMAIN`으로 릴리스 도메인을 지정 |
| `APP_ORIGIN` | 기본값 `https://lotto.mintwool.com`. 직접 Node로 실행할 때 실제 HTTPS 주소를 입력하며, Compose에서는 릴리스 도메인으로 자동 설정 |
| `PORT` | 직접 실행하는 Node 서버 포트, 기본값 `3000`. 운영 컨테이너 내부는 `3000`으로 고정 |
| `APP_PORT` | 서버 Caddy가 연결하는 호스트 포트, 기본값 `3000`. `127.0.0.1`에만 바인딩 |
| `DATA_DIR` | 직접 실행 시 `./data`; 운영 컨테이너에서는 영구 볼륨의 `/app/data`로 자동 설정 |
| `BACKUP_DIR` | 직접 실행 시 `./backups`; 운영 컨테이너에서는 영구 볼륨의 `/app/backups`로 자동 설정 |
| `BOOTSTRAP_USERNAME` | 최초 생성할 계정, 기본값 `textimage`. 초기 설정 명령에서 정한 이름을 유지 |
| `BOOTSTRAP_PASSWORD_HASH` | 초기 설정 명령으로 생성한 해시. 값과 작은따옴표를 유지하며, 평문 비밀번호를 입력하지 않음 |
| `TELEGRAM_ENABLED` | 기본값 `false`. 봇 토큰과 사용자 ID를 준비한 뒤 `true`로 설정 |
| `TELEGRAM_BOT_TOKEN` | BotFather에서 발급한 봇 토큰. 봇 미사용 시 비워 둠 |
| `TELEGRAM_ALLOWED_USER_ID` | 봇 사용을 허용할 본인의 숫자 사용자 ID. 확인 절차는 [텔레그램 개인 봇](#텔레그램-개인-봇) 참고 |
| `TELEGRAM_SITE_USERNAME` | 봇과 연결할 기존 사이트 계정 이름. 비워 두면 `BOOTSTRAP_USERNAME` 사용 |

직접 Node로 운영할 때는 화면·API를 함께 빌드하고 HTTPS 프록시 뒤에서 실행합니다. `APP_ORIGIN`은 실제 HTTPS 사이트 주소로 설정합니다.

```powershell
npm.cmd run build
$env:NODE_ENV = 'production'
npm.cmd start
```

## OCI 배포

### 서버 최초 준비

- 도메인의 DNS A 레코드를 VM 고정 공인 IP에 연결합니다. IPv6를 구성하지 않았다면 오래된 AAAA 레코드를 제거합니다.
- OCI NSG/보안 목록과 OS 방화벽에서 TCP 80·443, GitHub runner에서 접근할 SSH 포트를 허용합니다. 앱 포트는 인터넷에 공개하지 않습니다.
- 배포용 SSH 공개 키를 서버 사용자의 `~/.ssh/authorized_keys`에 등록하고, 비대화형 인증이 가능한 개인 키를 준비합니다.
- 서버 호스트 키 지문을 OCI 콘솔 등 신뢰할 수 있는 경로에서 확인한 뒤 일치하는 `known_hosts` 항목을 준비합니다.

```sh
sudo install -d -m 700 -o "$USER" -g "$(id -gn)" /opt/mintwool/lotto
docker compose version
command -v flock curl tar
```

`ssh-keyscan -p 22 YOUR_VM_IP`로 공개 호스트 키를 수집할 수 있으며, 지문은 별도로 확인합니다. SSH 포트가 22가 아니면 `known_hosts`의 호스트 표기는 `[호스트]:포트`입니다. 등록한 접속 호스트와 키 항목이 일치해야 합니다.

### GitHub Actions

[배포 워크플로](.github/workflows/deploy.yml)는 `main` push와 PR에서 자동 테스트·운영 빌드·셸 문법·Linux 컨테이너·QR worker를 검증합니다. 검증이 성공한 `main` push와 `main`의 수동 실행만 배포하며, 더 최신 `main` 커밋이 있으면 오래된 실행의 배포를 건너뜁니다.

저장소의 **Settings → Secrets and variables → Actions**에 다음 Repository secrets와 variables를 등록합니다. Tools도 같은 이름과 위치를 사용하며, GitHub Environment는 참조하지 않습니다.

| Secret                | 내용                                                              |
| --------------------- | ----------------------------------------------------------------- |
| `OCI_SSH_PRIVATE_KEY` | PC의 `C:\Users\RDS\.ssh\mintwool_actions` 개인키 전체, BEGIN·END 포함 |
| `OCI_SSH_KNOWN_HOSTS` | PC의 `C:\Users\RDS\Documents\OCI\known_hosts` 전체. 서버의 `/etc/ssh/ssh_host_ed25519_key.pub`와 지문을 대조한 값 |
| `OCI_ENV_BOOTSTRAP`   | PC의 `Lotto/.env.oci` 전체. `setup:admin`이 생성한 암호 해시를 포함하는 최초 설치용 설정 |

| Variable               | 기본값·용도                                       |
| ---------------------- | ------------------------------------------------- |
| `OCI_HOST`             | VM 공인 IP 또는 SSH 접속 DNS 이름                |
| `OCI_USERNAME`         | `ubuntu`                                          |
| `OCI_SSH_PORT`         | `22`                                              |
| `OCI_DEPLOY_DIR`       | `/opt/mintwool/lotto`                                 |
| `APP_DOMAIN`           | `lotto.mintwool.com`                              |
| `OCI_PROXY_MODE`       | `existing`; 단독 프록시는 `caddy`                 |
| `OCI_DEPLOY_LOCK_FILE` | 기본값 없음. 공동 운영 서버의 공유 잠금 파일 경로 |

`OCI_ENV_BOOTSTRAP`은 **서버 루트에 `.env`가 없을 때만** 적용됩니다. 최초 설치 이후에는 Secret을 삭제할 수 있으며, 이후 설정은 [운영 환경설정 변경](#운영-환경설정-변경) 절차로 관리합니다.

`main`에 push하거나 Actions의 **Verify and deploy to OCI → Run workflow → main**으로 배포합니다. 두 프로젝트 모두 검증 job 성공 후 `npm run deploy:oci`로 배포하며 이 명령은 GitHub Linux 실행기의 CI용 진입점입니다. 소스를 SSH로 전달하고 VM에서 이미지를 빌드하므로 이미지 레지스트리와 OCI API 키는 필요하지 않습니다. SSH 호스트 키 또는 필수 Secret에 문제가 있으면 Actions 로그를 확인합니다.

### 단독 프록시와 공용 프록시

단독 서버에서는 `OCI_PROXY_MODE=caddy`를 사용합니다. Compose의 Caddy가 인증서 발급·갱신과 HTTP→HTTPS 이동을 관리하며, 인증서는 영속 볼륨에 저장됩니다.

기존 Nginx/Caddy가 80·443을 사용한다면 `OCI_PROXY_MODE=existing`을 지정합니다. 최초 배포 전에 기존 프록시에서 도메인을 `127.0.0.1:3000`으로 연결하고 HTTPS를 설정합니다. Nginx를 사용하면 원래 `Host`, `X-Real-IP`, `X-Forwarded-Proto` 헤더를 전달합니다. 앱 포트를 바꾸면 서버 `.env`의 `APP_PORT`와 프록시 주소도 맞춥니다. 이 모드에서는 앱만 배포하고 공용 프록시는 재시작하지 않습니다.

Tools와 같은 서버의 공용 Caddy를 사용할 때는 `OCI_PROXY_MODE=existing`, `OCI_DEPLOY_LOCK_FILE=/opt/mintwool/deploy.lock`을 등록합니다. 공유 잠금으로 서버 작업을 직렬화하며 최대 15분 기다립니다. 잠금 파일은 PC의 `OCI/setup-server.sh`로 최초 준비하고, 공동 운영 절차는 `C:\Users\RDS\Documents\OCI\README.md`를 참고합니다.

### 수동 PowerShell 배포

[수동 배포 스크립트](scripts/deploy.ps1)도 같은 서버 배포·마이그레이션·복구 절차를 사용합니다. 첫 배포에서는 로컬 `.env`를 전달하고 이후 서버의 기존 `.env`를 유지합니다. SSH 호스트 키는 미리 등록하거나 `-KnownHostsFile`로 확인된 파일을 지정합니다.

```powershell
.\scripts\deploy.ps1 -SshHost YOUR_VM_IP -SshUser ubuntu -IdentityFile C:\keys\oci-deploy -KnownHostsFile C:\keys\oci_known_hosts
```

사용자 지정 SSH 포트에는 `-SshPort`, 기존 프록시에는 `-UseExistingProxy`를 추가합니다. Tools와 공동 운영하는 경우 `-UseExistingProxy -DeployLockFile /opt/mintwool/deploy.lock`을 함께 지정합니다. 실행 중인 앱에 관리되는 릴리스 기록이 없으면 자동 전환하지 않습니다.

### 배포 순서와 실패 처리

배포는 이미지 빌드·QR 검사 → 앱 중지 → SQLite 최종 백업 → 마이그레이션 → 앱 시작 → 컨테이너·로컬 `/healthz`·도메인 HTTPS 확인 순서입니다. 빌드와 QR 검사는 기존 앱이 실행 중일 때 진행하고, DB 변경에는 잠깐의 서비스 중단이 있습니다.

GitHub의 배포 작업과 VM의 `flock`으로 동시 배포를 차단합니다. 릴리스는 `releases/<릴리스-ID>`에 저장되며 `current`는 마지막 정상 배포, `previous`는 그 이전 릴리스입니다. 서버 루트 `.env`, Compose 프로젝트 `lotto-note`, 데이터·백업·인증서 볼륨은 유지됩니다.

| 실패 단계       | 처리                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| 빌드·QR 검사    | 기존 앱을 계속 운영                                                    |
| 백업            | 마이그레이션 없이 기존 앱을 다시 시작                                  |
| 마이그레이션    | 백업을 복원하고 이전 앱을 다시 시작. 복구 성공 후에도 배포 결과는 실패 |
| 최초 배포       | 이전 앱이 없으므로 DB를 보존하고 배포를 중단                           |
| 새 앱 시작 이후 | 새 기록을 보존하고 앱을 중지. 수정 후 재배포하거나 수동 복구           |

배포 로그에는 실패 단계·릴리스 ID·백업 경로가 표시됩니다. 앱 시작 이후 실패한 릴리스는 `current`에 반영되지 않으므로 해당 `releases/<릴리스-ID>`에서 로그를 확인합니다. 소스 릴리스·이미지·배포 백업은 자동 삭제하지 않습니다.

## 운영 환경설정 변경

운영 설정 원본은 **서버의 `/opt/mintwool/lotto/.env`**이며, 각 릴리스의 `.env`는 이 파일을 가리킵니다. PC의 `.env`·최초 설치용 `.env.oci`는 Git에서 제외됩니다. PC 파일이나 `OCI_ENV_BOOTSTRAP` Secret을 수정해도 이미 설치된 서버 설정에는 반영되지 않습니다.

입력할 값은 위의 [환경변수 표](#설치와-환경설정)를 참고하며, 한 줄에 `항목명=값` 형식으로 작성합니다. 공용 Caddy를 사용하는 현재 설정은 도메인 `lotto.mintwool.com`, 호스트 포트 `3000`입니다. 도메인을 변경할 때는 GitHub Variable `APP_DOMAIN`, DNS, Caddy의 도메인 설정을 함께 맞춥니다. `APP_PORT`를 변경할 때는 Caddy가 연결하는 포트도 맞춥니다. 생성된 계정은 `BOOTSTRAP_USERNAME`이나 해시를 바꿔 재배포해도 변경되지 않습니다.

GitHub 배포가 끝난 상태에서 다음 순서로 변경합니다.

1. **Ubuntu 서버의 SSH 터미널**에서 기존 설정을 백업하고 편집합니다.

   ```bash
   cd /opt/mintwool/lotto
   cp -p .env ".env.backup-$(date +%Y%m%d-%H%M%S)"
   nano .env
   ```

2. 현재 파일에서 변경할 항목의 줄만 수정합니다. `nano`에서는 **Ctrl+O → Enter → Ctrl+X**로 저장하고 종료합니다. `BOOTSTRAP_PASSWORD_HASH='scrypt$…'`의 작은따옴표를 유지합니다.
3. [GitHub 배포 워크플로](https://github.com/textimage/lotto-mintwool/actions/workflows/deploy.yml)에서 **Run workflow → Branch: main → Run workflow**를 실행합니다. 설정만 변경했다면 새 코드 커밋이나 `OCI_ENV_BOOTSTRAP` 갱신은 필요하지 않습니다. 배포가 변경된 설정으로 앱 컨테이너를 새로 생성하며 DB·백업 볼륨은 유지합니다.
4. Actions가 성공하면 서버에서 상태를 확인합니다.

   ```bash
   cd /opt/mintwool/lotto/current
   sh scripts/compose.sh ps
   sh scripts/compose.sh logs --tail=50 app
   curl -fsS --max-time 20 https://lotto.mintwool.com/healthz
   ```

컨테이너에 `healthy`, 상태 응답에 `{"ok":true}`가 나오면 정상입니다. 텔레그램을 설정했다면 봇 개인 대화에서 `/help` 응답도 확인합니다. 설정 파일 수정이나 컨테이너 `restart`만으로는 새 환경변수가 적용되지 않으므로 컨테이너를 재생성하는 배포 절차를 완료합니다.

## 상태 점검·백업·복구

서버 점검에는 해당 릴리스의 이미지와 도메인을 사용하는 `scripts/compose.sh`를 사용합니다.

```sh
cd /opt/mintwool/lotto/current
sh scripts/compose.sh ps
sh scripts/compose.sh logs --tail=100 app
curl --fail https://lotto.mintwool.com/healthz
sh scripts/compose.sh exec -T app node dist/server/server/maintenance.js backup
sh scripts/compose.sh exec -T app node dist/server/server/maintenance.js sync
```

데이터는 `app_data`, 백업은 `app_backups` 볼륨에 저장됩니다. 운영 중 `docker compose down -v`를 사용하면 데이터 볼륨도 삭제되므로 사용하지 않습니다.

매일 03:30(한국 시간)에 SQLite 온라인 백업을 만들고 최근 14개를 보관합니다. 배포 백업 `deploy-<릴리스-ID>.sqlite`는 이 보관 정책에서 제외됩니다. VM 외부 보관용 개인 JSON 백업은 사이트 설정 화면에서 내려받습니다. 개인 JSON 백업에는 개인 기록·설정이 포함되고 계정·세션·회차 데이터·봇 상태·토큰은 포함되지 않습니다. JSON 복원은 개인 기록과 설정을 교체하며 계정·세션·회차 데이터는 유지합니다.

마이그레이션은 배포 또는 앱 시작 시 자동으로 실행합니다. 현재 앱보다 새로운 DB 버전이나 잘못된 마이그레이션 이력은 오류로 처리합니다. 유지보수 명령 `migrate`는 계정을 생성하거나 봇·동기화를 시작하지 않습니다.

### 이전 DB와 앱으로 복구

수정 후 재배포가 기본 복구 방법입니다. 이전 DB로 되돌려야 하면 모든 앱과 DB 연결을 먼저 종료하고, 현재 DB를 별도 백업한 뒤 마지막 정상 앱과 호환되는 백업을 선택합니다. 선택한 백업 이후 기록은 되돌아갑니다.

아래 명령은 마지막 정상 릴리스인 `current`에서 실행합니다. `FAILED_RELEASE_ID`를 실제 배포 백업의 릴리스 ID로 바꾸고, 수동 백업에는 기존 파일과 겹치지 않는 경로를 사용합니다.

```sh
cd /opt/mintwool/lotto/current
sh scripts/compose.sh stop app
sh scripts/compose.sh run --rm --no-deps -T app node dist/server/server/maintenance.js snapshot /app/backups/manual-before-restore.sqlite
sh scripts/compose.sh run --rm --no-deps -T app node dist/server/server/maintenance.js restore /app/backups/deploy-FAILED_RELEASE_ID.sqlite
sh scripts/compose.sh up -d --no-build --pull never
```

`existing` 프록시 모드에서는 마지막 명령에 `app`을 추가합니다. `snapshot`은 스키마 변경 없이 WAL의 커밋을 포함한 백업을 만들고 검증하며 기존 백업을 덮어쓰지 않습니다. DB가 없으면 파일을 만들지 않고 종료 코드 3을 반환합니다. 배포에서는 최초 설치에만 이를 허용합니다.

`restore`는 백업 무결성과 종료된 WAL 연결을 확인하며, 교체되는 DB를 `app_data`의 `lotto.sqlite.before-restore-<UUID>`로 보존합니다. 복원 명령은 마이그레이션을 실행하지 않습니다. 복구 후 `/healthz`, HTTPS 접속, 로그인과 개인 기록을 확인합니다.

## 텔레그램 개인 봇

사이트와 같은 서버·DB에서 지정한 사용자 ID의 개인 대화만 처리합니다. 서버가 실행 중이면 브라우저를 닫아도 봇과 토요일 알림이 동작합니다.

1. Telegram의 [BotFather](https://t.me/BotFather)에서 `/newbot`으로 봇을 만들고 토큰을 받습니다.
2. 서버 `.env`에 `TELEGRAM_BOT_TOKEN`을 설정하고 `TELEGRAM_ENABLED=false`를 유지한 채 [운영 환경설정 변경](#운영-환경설정-변경) 절차로 배포합니다.
3. 본인의 봇 개인 대화에서 `/start`를 보낸 뒤 아래 명령으로 사용자 ID를 확인합니다. 봇이 비활성화되어 있어 답장이 없어도 정상입니다.

```sh
cd /opt/mintwool/lotto/current
sh scripts/compose.sh exec -T app node dist/server/scripts/telegram-check.js --identify
```

여러 ID가 나오면 본인의 개인 대화 ID를 선택하고 서버 `.env`를 설정합니다.

```dotenv
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=<BotFather에서 받은 토큰>
TELEGRAM_ALLOWED_USER_ID=<본인의 숫자 사용자 ID>
TELEGRAM_SITE_USERNAME=<사이트 로그인 사용자명>
```

`TELEGRAM_SITE_USERNAME`을 비워 두면 `BOOTSTRAP_USERNAME`을 사용합니다. 사용자 ID와 `TELEGRAM_ENABLED=true`를 저장한 뒤 같은 [운영 환경설정 변경](#운영-환경설정-변경) 절차로 다시 배포하고 봇 응답을 확인합니다.

같은 토큰은 한 서버에서만 활성화하고 로컬에서는 `TELEGRAM_ENABLED=false`로 유지합니다. 봇과 ID 확인 명령은 함께 `getUpdates`를 실행하면 충돌합니다. 기존 webhook은 해당 연동을 종료한 뒤 Telegram `deleteWebhook` API로 해제합니다. 봇 오류는 `telegram_configuration_invalid`, `telegram_start_failed` 로그로 확인할 수 있습니다.

- `/start`, `/help`: 사용법을 표시합니다. 차단을 해제한 후 `/start`로 대기 중인 알림을 다시 받을 수 있습니다.
- 번호 6개 입력: 과거 당첨 결과를 대조하며 구매 기록을 만들지 않습니다.
- 사진 또는 JPEG·PNG 파일: QR로 즉시 구매 등록합니다. 중복 복권 등록을 방지하고 사진은 보관하지 않습니다. 파일 20MB·4천만 픽셀·해독 10초 제한이 있습니다.
- 토요일 21:00(한국 시간)부터 그날 추첨 회차의 구매·당첨 결과를 확인합니다. 데이터 미수집·배당 집계 중·미확정 게임이 있는 동안은 발송하지 않고, 모두 확정되면 세전 총 당첨금과 게임별 당첨금을 포함한 결과를 한 번 전송합니다. 구매내역이 없어도 회차 데이터가 확정된 뒤 당첨번호를 전송합니다.

첫 활성화 이전 회차는 자동 발송하지 않습니다. 재시작하면 진행 중인 알림을 복구하고 직전 토요일의 누락 알림만 보충합니다. 이전 버전의 미전송 중간 알림은 취소하고 확정 결과를 기다립니다. 미전송 확정 알림도 발송 조건을 다시 검사하며, 이미 발송한 확정 결과는 반복하지 않습니다. 전송 응답이 유실되면 재시도로 같은 메시지가 다시 도착할 수 있습니다. 토큰·사용자 ID·사이트 계정 변경 시 기존 대상의 대기 메시지는 새 사용자에게 보내지 않습니다. 봇 상태는 SQLite 전체 백업으로 복구합니다.

운영 컨테이너의 native 이미지 라이브러리와 QR worker는 다음 명령으로 점검합니다. 메모리에서 검증용 QR을 생성·해독하며 구매 기록이나 Telegram 전송은 발생하지 않습니다.

```sh
sh scripts/compose.sh exec -T app node dist/server/scripts/telegram-qr-check.js
```

## 동기화와 정기 작업

단일 Node 프로세스가 한국 시간 토요일 20:45~일요일 02:45에 15분 간격, 매일 03:00에 당첨 결과를 갱신합니다. 시작 시 중단된 작업을 이어가고 자동 갱신이 켜져 있으면 최신 결과를 확인합니다. 자동 갱신을 꺼도 직접 시작한 작업은 계속 진행됩니다.

첫 수집은 GitHub 원본의 고정된 스냅샷에서 전체 회차를 가져오고 동행복권 API로 최신·누락·미확정 회차를 보충합니다. 진행 상태와 오류는 사이트 설정 화면에서 확인하고 필요하면 직접 동기화를 실행합니다.

텔레그램은 회차 데이터와 모든 구매 게임의 결과 확정을 위해 일요일 03:00까지 15분 간격, 이후 매일 03:00에 재조회합니다. 사이트의 자동 갱신을 꺼도 봇의 재조회는 동작하며, 확정 결과를 발송 대기열에 등록하면 해당 회차 재조회를 종료합니다.
