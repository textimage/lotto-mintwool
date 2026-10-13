# OCI 설치와 GitHub Actions 배포

새 서버와 도메인에 Lotto·Tools를 설치하는 안내입니다. 이 저장소에 설치 파일과 문서가 모두 포함되며 다른 저장소의 배포 문서를 가져올 필요는 없습니다. 선택한 앱의 소스에 대한 GitHub 접근·설정 권한은 필요합니다.

| 설치 모드 | 앱 | 필요한 도메인 | 서버 폴더·내부 포트 |
|---|---|---|---|
| `both` | Lotto와 Tools | 서로 다른 두 이름 | `/opt/mintwool/lotto`: 3000, `/opt/mintwool/tools`: 3001 |
| `lotto` | Lotto만 | 한 이름 | `/opt/mintwool/lotto`: 3000 |
| `tools` | Tools만 | 한 이름 | `/opt/mintwool/tools`: 3001 |

두 도메인은 같은 상위 도메인의 서브도메인이어도, 서로 다른 도메인이어도 됩니다. 단독 운영은 서브도메인 또는 루트 도메인을 사용할 수 있습니다. **세 방식 모두 서버 Caddy가 HTTPS를 처리하고 Docker에서는 선택한 앱만 실행**하므로 GitHub의 `OCI_PROXY_MODE`는 모두 `existing`입니다.

지원 대상은 **Ubuntu 24.04 LTS ARM64 또는 AMD64**, 비밀번호 없이 sudo를 사용할 수 있는 기본 `ubuntu` 계정입니다. 기준 사양은 2 OCPU·12GB RAM·50GB 디스크이며 Tools의 컨테이너 메모리 상한은 8GB입니다. Lotto 단독의 최소 사양은 별도로 측정하지 않았습니다. 기존 웹 서비스가 없는 새 VM에서 시작합니다. 이미 운영 중인 앱의 경로·설치 모드를 자동 이전하는 절차는 포함하지 않습니다.

## 1. PC 설정값·소스·관리자 키 준비

**Windows PowerShell**을 사용합니다. PC에는 Node.js 24, Git, OpenSSH Client가 필요하며 Docker는 배포에 필요하지 않습니다.

```powershell
node --version
git --version
ssh -V
```

다음 블록을 실제 환경에 맞춥니다. `203.0.113.10`, `example.com`, `YOUR_ACCOUNT`는 설명용 자리입니다. 이후 PC 명령은 **같은 PowerShell 창**에서 실행하며 창을 다시 열면 이 블록을 다시 실행합니다. 서버 생성 후 `$serverIp`를 최종 공인 IPv4로 바꿉니다.

```powershell
$appMode = 'both'                       # both / lotto / tools
$deploymentRoot = Join-Path $env:USERPROFILE 'mintwool-deploy'
$serverIp = '203.0.113.10'               # 실제 서버 IPv4로 교체
$sshUser = 'ubuntu'
$sshPort = 22
$lottoDomain = 'lotto.example.com'       # Lotto 선택 시 사용
$toolsDomain = 'tools.example.com'       # Tools 선택 시 사용
$acmeEmail = 'admin@example.com'         # 본인의 인증서 안내 이메일
$lottoRepository = 'https://github.com/YOUR_ACCOUNT/lotto-mintwool.git'
$toolsRepository = 'https://github.com/YOUR_ACCOUNT/tools-mintwool.git'
$managerKey = Join-Path $env:USERPROFILE '.ssh\mintwool_oci'
$actionsKey = Join-Path $env:USERPROFILE '.ssh\mintwool_actions'
$knownHosts = Join-Path $deploymentRoot 'oci_known_hosts'
$lottoDirectory = Join-Path $deploymentRoot 'Lotto'
$toolsDirectory = Join-Path $deploymentRoot 'Tools'
```

Lotto 단독은 `$appMode='lotto'`, Tools 단독은 `$appMode='tools'`로 선택하고 해당 도메인·저장소만 준비합니다. 도메인에 `https://`·경로·포트를 넣지 않으며 국제화 도메인은 ASCII/Punycode 이름을 사용합니다.

저장소에는 이 프로젝트의 소스와 `.github/workflows/deploy.yml`이 있어야 합니다. 다른 GitHub 계정을 사용한다면 접근 가능한 원본을 fork하거나 소스를 본인 저장소에 올린 뒤 위 URL을 입력합니다. 비공개 원본은 접근 권한이 먼저 필요합니다. fork는 **Actions** 탭에서 워크플로를 활성화합니다.

```powershell
New-Item -ItemType Directory -Force $deploymentRoot | Out-Null
if ($appMode -ne 'tools') {
    git clone $lottoRepository $lottoDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Lotto 다운로드 실패' }
}
if ($appMode -ne 'lotto') {
    git clone $toolsRepository $toolsDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Tools 다운로드 실패' }
}
$setupDirectory = if ($appMode -eq 'tools') {
    Join-Path $toolsDirectory 'OCI'
} else {
    Join-Path $lottoDirectory 'OCI'
}
Get-ChildItem $setupDirectory
```

기존 checkout이 있으면 clone을 반복하지 않고 경로를 맞춥니다. **Code → Download ZIP**으로 받아도 `OCI` 설치 파일이 포함됩니다. 업데이트를 push하려면 Git checkout·`origin`·`main`을 준비합니다. 설치 파일은 같은 checkout의 파일을 함께 사용하며 `.gitattributes`가 Bash의 LF 줄바꿈을 유지합니다.

관리자 키는 암호를 설정하고 `.pub`만 OCI에 등록합니다. 기존 키를 덮어쓰지 않으며 필요하면 `$managerKey`를 새 파일명으로 바꿉니다.

```powershell
New-Item -ItemType Directory -Force (Join-Path $env:USERPROFILE '.ssh') | Out-Null
if (!(Test-Path -LiteralPath $managerKey)) {
    ssh-keygen -t ed25519 -f $managerKey -C 'mintwool-manager'
    if ($LASTEXITCODE -ne 0) { throw '관리자 키 생성 실패' }
}
Get-Content -LiteralPath "${managerKey}.pub"
```

## 2. OCI 네트워크와 서버 생성

**OCI 웹 콘솔**에서 다음을 준비합니다. 기존 VCN은 같은 조건인지 확인합니다.

1. VCN 생성: 예 `mintwool-vcn`, IPv4 `10.20.0.0/16`, DNS hostnames 사용.
2. VCN에 활성화된 Internet Gateway 생성.
3. 공용 Route Table에 `0.0.0.0/0 → Internet Gateway` 추가.
4. Regional **공용** 서브넷 생성: 예 `10.20.1.0/24`, 위 Route Table 연결. IPv6는 구성하지 않습니다.
5. Ubuntu **24.04 LTS ARM64**, `VM.Standard.A1.Flex`, 기준 2 OCPU·12GB·50GB로 서버 생성. 위 공용 서브넷과 1단계 관리자 `.pub`를 선택합니다. AMD64 서버는 이미지와 Shape도 AMD64로 맞춥니다.
6. Running 상태에서 공인 IPv4 확인. 장기 운영에는 예약 공인 IP를 연결하고 최종 값을 `$serverIp`에 입력합니다.

무료 대상 표시·계정 할당량·예상 비용을 확인한 뒤 생성합니다. 재고가 없으면 재고를 확인하고 사양이나 유료 Shape를 자동 변경하지 않습니다. [VCN 생성](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/create_vcn.htm), [공인 IP](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm), [무료 자원](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

서브넷 Security List 또는 VNIC에 연결한 NSG에 다음 **Stateful Ingress**를 추가합니다. Source type은 CIDR, Source port는 All이며 기본 인터넷 아웃바운드 허용을 유지합니다.

| Source CIDR | 프로토콜 | Destination port | 용도 |
|---|---|---|---|
| `0.0.0.0/0` | TCP | 22 | 관리자·GitHub 제공 실행기의 SSH |
| `0.0.0.0/0` | TCP | 80 | 인증서 발급·HTTP 리다이렉트 |
| `0.0.0.0/0` | TCP | 443 | HTTPS |
| `0.0.0.0/0` | UDP | 443 | 선택 사항인 HTTP/3 |

관리자 IP만 SSH에 허용하면 GitHub 제공 실행기가 연결되지 않습니다. SSH는 키로 인증하고 앱 포트 3000·3001·5173은 공개하지 않습니다. 설치 스크립트는 OS 웹 허용 규칙만 추가합니다. 기본 22가 아닌 SSH 포트는 먼저 서버 sshd·OCI·OS 방화벽을 설정한 뒤 `$sshPort`도 맞춥니다. [OCI 보안 규칙](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securityrules.htm)

다른 클라우드도 Ubuntu 24.04와 비대화형 sudo 사용자, 공인 IPv4·인터넷 경로·방화벽을 준비하면 같은 스크립트를 사용할 수 있습니다. 실제 운영 검증 환경은 OCI ARM64입니다.

## 3. DNS와 관리자 SSH 확인

**DNS 관리 화면**에서 선택한 앱만 A 레코드로 서버 IPv4에 연결합니다. 두 앱이면 두 개, 단독이면 한 개입니다. 루트 도메인은 업체의 루트 표시(보통 `@`)를 사용합니다. TTL은 기본값 또는 300초입니다.

Cloudflare는 **DNS only**로 설정합니다. 같은 이름의 충돌 A·CNAME을 정리하고 IPv6를 구성하지 않았으므로 AAAA가 없어야 합니다. Tools 검사는 프록시 IP나 AAAA가 남으면 중단합니다. 다른 서비스의 레코드는 유지합니다.

**PC PowerShell:**

```powershell
if ($appMode -ne 'tools') { Resolve-DnsName $lottoDomain -Type A }
if ($appMode -ne 'lotto') { Resolve-DnsName $toolsDomain -Type A }
ssh -i $managerKey -p $sshPort -o HostKeyAlgorithms=ssh-ed25519 "${sshUser}@${serverIp}"
```

DNS는 해당 서버 IPv4를 반환해야 합니다. 첫 SSH의 ED25519 지문은 인스턴스 부팅 콘솔 로그의 `SSH HOST KEY FINGERPRINTS` 등 **인스턴스 내부 지문**과 대조한 뒤 승인합니다. Console history 또는 Cloud Shell 인스턴스 콘솔을 이용합니다. 콘솔 연결 서비스 자체의 지문과 VM SSH 지문은 다릅니다. [인스턴스 콘솔·로그](https://docs.oracle.com/en-us/iaas/Content/Compute/References/serialconsole.htm)

**서버 SSH:**

```bash
uname -m
cat /etc/os-release
sudo -n true
mkdir -p ~/oci-setup
exit
```

Ubuntu 24.04, `aarch64`(ARM64) 또는 `x86_64`(AMD64), 암호 없는 sudo 성공을 확인합니다. `exit` 후 PC 창으로 돌아옵니다.

## 4. 선택한 방식으로 서버 설치

**PC PowerShell:** 저장소에 포함된 파일을 함께 전송합니다.

```powershell
scp -i $managerKey -P $sshPort (Join-Path $setupDirectory 'setup-server.sh') (Join-Path $setupDirectory 'Caddyfile') "${sshUser}@${serverIp}:~/oci-setup/"
if ($LASTEXITCODE -ne 0) { throw '설치 파일 전송 실패' }
ssh -i $managerKey -p $sshPort "${sshUser}@${serverIp}"
```

**서버 SSH:** 다음 중 선택한 명령 **하나만** 실행합니다. 도메인·이메일·사용자를 1단계의 실제 값으로 바꿉니다.

### 두 앱·두 도메인

```bash
cd ~/oci-setup
sudo bash setup-server.sh --app both --lotto-domain lotto.example.com --tools-domain tools.example.com --email admin@example.com --user ubuntu
```

### Lotto만·한 도메인

```bash
cd ~/oci-setup
sudo bash setup-server.sh --app lotto --lotto-domain lotto.example.com --email admin@example.com --user ubuntu
```

### Tools만·한 도메인

```bash
cd ~/oci-setup
sudo bash setup-server.sh --app tools --tools-domain tools.example.com --email admin@example.com --user ubuntu
```

스크립트는 Docker Engine·Compose와 Caddy를 공식 저장소에서 설치하고 선택한 앱의 폴더만 만듭니다. Tools는 입력 도메인과 `APP_PORT=3001`, `JOB_CONCURRENCY=1`로 초기 `.env`를 준비합니다. Lotto `.env`는 6단계 최초 배포 Secret에서 설치합니다. Caddy도 선택한 앱 블록만 만들고 **Tools WebSocket CSP의 WSS 주소도 입력 도메인으로 설정**합니다.

| 항목 | 서버 결과 |
|---|---|
| 공용 HTTPS 설정 | `/etc/caddy/Caddyfile` |
| 선택한 앱 폴더 | 배포 사용자 소유, 권한 700 |
| Tools 초기 `.env` | 배포 사용자 소유, 권한 600 |
| 배포 잠금 | `/opt/mintwool/deploy.lock`, 배포 사용자 소유, 권한 600 |
| 설치 모드·도메인 기록 | `/opt/mintwool/.setup-config` |
| 재부팅 후 웹 포트 허용 | `mintwool-web-ports.service` |

기존 웹 서비스·관리하지 않는 Caddy·예상하지 않은 앱 폴더·심볼릭 링크는 덮어쓰지 않고 중단합니다. 같은 모드·도메인·사용자로 재실행하면 `.env`와 잠금 inode를 보존합니다. 다른 모드·도메인의 재실행은 거부하며 도메인 변경은 9단계를 따릅니다. 이미 정상 운영 중인 서버는 설치 스크립트를 다시 실행할 필요가 없습니다.

`exit` 후 SSH에 **다시 접속**하여 Docker 그룹 가입을 적용하고 서버에서 확인합니다.

```bash
docker compose version
docker info >/dev/null
sudo systemctl is-active docker caddy mintwool-web-ports
stat -c '%n %U:%G %a' /opt/mintwool/deploy.lock
```

선택한 도메인을 `curl -I https://실제도메인`으로 확인합니다. **앱 배포 전에는 TLS 정상·HTTP 502가 정상**입니다. 인증서 오류는 DNS·80/443·Caddy 로그부터 확인합니다. [Docker 설치](https://docs.docker.com/engine/install/ubuntu/), [Caddy 설치](https://caddyserver.com/docs/install), [자동 HTTPS](https://caddyserver.com/docs/automatic-https)

## 5. 배포용 SSH 키와 서버 호스트 키

관리자 키와 별도로 자동 배포 키를 준비합니다. **PC PowerShell:** 키 암호 질문에는 Enter를 눌러 암호 없이 만들며 기존 파일은 덮어쓰지 않습니다.

```powershell
if (!(Test-Path -LiteralPath $actionsKey)) {
    ssh-keygen -t ed25519 -f $actionsKey -C 'mintwool-actions'
    if ($LASTEXITCODE -ne 0) { throw '배포용 키 생성 실패' }
}
scp -i $managerKey -P $sshPort "${actionsKey}.pub" "${sshUser}@${serverIp}:~/mintwool_actions.pub"
if ($LASTEXITCODE -ne 0) { throw '배포용 공개키 전송 실패' }
ssh -i $managerKey -p $sshPort "${sshUser}@${serverIp}"
```

**서버 SSH:** 기존 관리자 공개키를 유지한 채 배포용 공개키를 추가합니다.

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
key=$(cat ~/mintwool_actions.pub)
grep -Fxq "$key" ~/.ssh/authorized_keys || printf '\n%s\n' "$key" >> ~/.ssh/authorized_keys
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
exit
```

마지막 두 출력은 **VM의 공개 호스트 키와 지문**입니다. 최초 관리자 접속에서 확인한 ED25519 지문과 같아야 합니다.

**PC PowerShell:** 신뢰된 관리자 접속으로 읽은 공개 호스트 키에서 새 서버의 `known_hosts`를 만듭니다.

```powershell
$publicHostKey = ssh -i $managerKey -p $sshPort -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 "${sshUser}@${serverIp}" 'sudo cat /etc/ssh/ssh_host_ed25519_key.pub'
if ($LASTEXITCODE -ne 0) { throw '호스트 키 읽기 실패' }
$hostKeyParts = $publicHostKey.Trim() -split '\s+'
if ($hostKeyParts.Count -lt 2 -or $hostKeyParts[0] -ne 'ssh-ed25519') { throw '호스트 키 형식 확인 필요' }
$hostField = if ($sshPort -eq 22) { $serverIp } else { "[${serverIp}]:${sshPort}" }
if (Test-Path -LiteralPath $knownHosts) { throw '기존 호스트 키 파일을 보존하려면 새 파일명을 지정하세요.' }
[System.IO.File]::WriteAllText($knownHosts, "$hostField $($hostKeyParts[0]) $($hostKeyParts[1])`n", [System.Text.UTF8Encoding]::new($false))
ssh-keygen -lf $knownHosts
ssh -i $actionsKey -p $sshPort -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$knownHosts" "${sshUser}@${serverIp}" whoami
```

지문이 서버 값과 같고 마지막에 지정한 사용자명이 암호 질문 없이 출력되어야 합니다. 배포용 키는 암호가 없어야 하며 출처를 확인하지 않은 `ssh-keyscan` 결과만 등록하지 않습니다.

## 6. Repository Secrets 등록

선택한 각 앱 저장소의 **Settings → Secrets and variables → Actions → Secrets → New repository secret**에서 등록합니다. Name에는 아래 이름, Secret에는 **원본 내용 전체**를 붙입니다. 파일 경로를 넣지 않습니다. 별도 GitHub Environment는 사용하지 않습니다. [Secrets 등록](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#creating-secrets-for-a-repository)

| Name | 등록할 앱 | 원본·용도 |
|---|---|---|
| `OCI_SSH_PRIVATE_KEY` | 선택한 모든 앱 | `$actionsKey` 개인키 전체. BEGIN·END 포함, 서버 로그인 |
| `OCI_SSH_KNOWN_HOSTS` | 선택한 모든 앱 | `$knownHosts` 전체. 서버 주소·키 종류·서버 공개 호스트 키, 접속 대상 검증 |
| `OCI_ENV_BOOTSTRAP` | Lotto 최초 설치 | `$lottoDirectory/.env.oci` 전체. 초기 계정 해시와 앱 설정 |

두 앱이 같은 서버라면 공통 Secret 두 개의 값도 같습니다. 단독은 해당 저장소만 등록합니다. 원본은 PC에 보관하고 Git·채팅·일반 로그에 올리지 않습니다. GitHub는 등록 후 본문을 표시하지 않으므로 갱신할 때도 원본을 사용합니다.

### OCI_SSH_PRIVATE_KEY

```powershell
Get-Content -Raw -LiteralPath $actionsKey | Set-Clipboard
```

클립보드를 Secret 칸에 붙입니다. **형식 예시**이며 다음 본문을 실제 키 대신 사용하지 않습니다.

```text
-----BEGIN OPENSSH PRIVATE KEY-----
<ssh-keygen이 생성한 개인키 본문 여러 줄>
-----END OPENSSH PRIVATE KEY-----
```

짝인 `${actionsKey}.pub`는 서버 `authorized_keys`에 들어갑니다. 공개키를 이 Secret에 넣으면 인증되지 않습니다.

### OCI_SSH_KNOWN_HOSTS

```powershell
Get-Content -Raw -LiteralPath $knownHosts | Set-Clipboard
```

**형식 예시**는 다음 한 줄입니다. `AAA...`는 자리 표시이며 실제 값은 5단계의 검증된 파일을 사용합니다.

```text
203.0.113.10 ssh-ed25519 AAA...실제서버공개호스트키...
```

22가 아닌 포트는 `[203.0.113.10]:2222`처럼 첫 필드를 작성합니다. 서버 주소·포트는 `OCI_HOST`·`OCI_SSH_PORT`와 일치해야 합니다. 서버를 교체하면 IP뿐 아니라 **새 VM의 호스트 키와 지문도 다시 확인**합니다. 배포용 `.pub`와 서버 공개 호스트 키는 서로 다른 키입니다.

### OCI_ENV_BOOTSTRAP — Lotto 선택 시만

**PC PowerShell:** 새 서버용 Lotto checkout에서 초기 아이디·비밀번호를 입력해 해시를 생성합니다. 기존 `.env.oci`는 덮어쓰지 않습니다.

```powershell
Set-Location $lottoDirectory
if (Test-Path .env.oci) { throw '기존 초기 설정을 확인하거나 새 checkout에서 준비하세요.' }
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Lotto 의존성 설치 실패' }
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run setup:admin
if ($LASTEXITCODE -ne 0) { throw '초기 계정 설정 실패' }
Copy-Item .env .env.oci
notepad.exe .env.oci
```

아이디는 3~80자, 비밀번호는 8~256자입니다. 메모장에서 도메인·주소·텔레그램 설정을 아래처럼 맞추고 저장합니다. **이미 생성된 실제 해시와 작은따옴표를 유지**합니다.

```dotenv
APP_DOMAIN=lotto.example.com
APP_ORIGIN=https://lotto.example.com
APP_PORT=3000
PORT=3000
DATA_DIR=./data
BACKUP_DIR=./backups
BOOTSTRAP_USERNAME=myadmin
BOOTSTRAP_PASSWORD_HASH='scrypt$<setup:admin이 생성한 실제 해시>'
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_ID=
TELEGRAM_SITE_USERNAME=
```

`APP_DOMAIN`은 `$lottoDomain`, `APP_ORIGIN`은 `https://`를 붙인 같은 이름입니다. 예제 해시나 평문 비밀번호를 넣지 않습니다. 로컬 봇은 비활성화합니다.

```powershell
Get-Content -Raw -LiteralPath (Join-Path $lottoDirectory '.env.oci') | Set-Clipboard
```

Lotto 저장소에 `OCI_ENV_BOOTSTRAP`으로 등록합니다. `.env`·`.env.oci`는 Git에서 제외됩니다. 이 Secret은 **서버 `/opt/mintwool/lotto/.env`가 없을 때만** 적용하며 이후 설정이나 이미 생성한 계정을 바꾸지 않습니다. 최초 로그인까지 확인하면 삭제할 수 있습니다.

Tools는 설치 스크립트가 초기 `.env`를 준비하므로 Bootstrap Secret이 필요 없습니다. 선택 기능의 `OPENAI_API_KEY`는 서버 `/opt/mintwool/tools/.env`에서 관리합니다.

## 7. Repository Variables 등록

각 앱 저장소의 **Settings → Secrets and variables → Actions → Variables → New repository variable**에서 다음 **7개 모두**를 등록합니다. Value에 따옴표를 붙이지 않습니다. 선택하지 않은 앱의 저장소는 설정하지 않습니다. [Variables 등록](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables#creating-configuration-variables-for-a-repository)

| Name | Lotto Value | Tools Value | 출처 |
|---|---|---|---|
| `OCI_HOST` | 실제 공인 IPv4 | 실제 공인 IPv4 | `$serverIp`, OCI 인스턴스 |
| `OCI_USERNAME` | `ubuntu` 또는 지정 사용자 | 같은 사용자 | `$sshUser`, 설치 `--user` |
| `OCI_SSH_PORT` | `22` 또는 실제 포트 | 같은 포트 | `$sshPort` |
| `OCI_DEPLOY_DIR` | `/opt/mintwool/lotto` | `/opt/mintwool/tools` | 설치가 준비한 폴더 |
| `APP_DOMAIN` | 실제 Lotto 도메인 | 실제 Tools 도메인 | `$lottoDomain` / `$toolsDomain`, DNS·설치 인자와 동일 |
| `OCI_PROXY_MODE` | `existing` | `existing` | 세 방식 모두 서버 Caddy 사용 |
| `OCI_DEPLOY_LOCK_FILE` | `/opt/mintwool/deploy.lock` | `/opt/mintwool/deploy.lock` | 설치가 준비한 잠금 |

예를 들어 Lotto 단독도 Lotto 열의 7개를 그대로 사용하되 IP·사용자·포트·도메인은 실제 값으로 넣습니다. Tools 단독도 Tools 열을 따릅니다. 최초 Secrets는 Lotto 3개, Tools 2개입니다.

주소·사용자·포트·폴더·도메인은 Variables, 개인키·검증된 호스트 키·초기 계정은 Secrets입니다. `RELEASE_ID`, `OCI_SSH_KEY_FILE`, `OCI_KNOWN_HOSTS_FILE`, `OCI_VERIFIED_SHA`는 실행기 내부 값입니다. 인증서 이메일은 서버 Caddy에 있고 Docker 설치도 끝났으므로 GitHub에 별도 항목을 추가하지 않습니다.

## 8. 첫 배포·로그인·이후 업데이트

선택한 앱 저장소의 **Actions → Verify and deploy to OCI → Run workflow → Branch: main**으로 첫 배포를 실행합니다. Tools는 `action: deploy`를 선택합니다. `verify`·`deploy`가 모두 성공해야 합니다. 첫 배포에는 새 코드 커밋이 필요하지 않습니다.

일반 업데이트는 **해당 앱의 PC Git 폴더**에서 실행합니다.

```powershell
git branch --show-current
git remote -v
git add .
git status --short
git diff --cached --stat
git commit -m "Update app"
git push -u origin main
```

브랜치가 `main`, `origin`이 본인 저장소인지 확인합니다. `.env`·개인키·실제 배포 설정·백업·사용자 자료는 커밋하지 않습니다. PR은 검증만 실행하고 검증된 최신 `main`만 배포합니다. 공용 잠금으로 같은 서버의 작업을 순서대로 실행합니다.

GitHub는 소스를 SSH로 전송하고 서버 CPU에 맞는 Docker 이미지를 빌드한 뒤 health·HTTPS를 확인합니다. OCI API 키·이미지 레지스트리는 필요 없습니다. 처음에는 다운로드로 수 분 걸리며 컨테이너 교체 중 짧은 중단이 생길 수 있습니다. GitHub 배포는 설치 스크립트를 실행하거나 공용 Caddy를 재시작하지 않습니다.

**PC PowerShell:**

```powershell
if ($appMode -ne 'tools') {
    curl.exe -I --connect-timeout 10 --max-time 30 "https://$lottoDomain"
    curl.exe -fsS --max-time 30 "https://$lottoDomain/healthz"
}
if ($appMode -ne 'lotto') {
    curl.exe -I --connect-timeout 10 --max-time 30 "https://$toolsDomain"
    curl.exe -fsS --max-time 30 "https://$toolsDomain/api/health"
}
```

정상은 HTTPS `200`과 `{"ok":true}`입니다. Lotto는 `setup:admin`에서 정한 계정으로 로그인합니다.

Tools는 **서버 SSH**에서 설치 코드를 읽습니다.

```bash
cd /opt/mintwool/tools/current
sh scripts/compose.sh exec -T app cat /app/data/private/setup-code.txt
```

실제 Tools 주소의 `/private/login`에서 초기 아이디 `admin`, 비밀번호 `1234`, 설치 코드를 입력하고 **먼저 10~128자의 새 비밀번호로 변경**합니다. 완료 후 설치 코드는 삭제되며 업데이트로 초기 계정이 다시 생성되지 않습니다. 코드는 일반 로그·채팅에 공유하지 않습니다.

Tools의 수동 `check`는 DNS·SSH·sudo·Docker, `status`는 릴리스·컨테이너 상태를 읽고 서버를 변경하지 않습니다. 이 경우 `verify`가 skipped인 것이 정상입니다. `rollback`은 직전 성공 릴리스·이미지로 복구하며 DB·보관함을 되돌리지 않습니다. 첫 배포에는 직전 릴리스가 없습니다. 기동·서버 HTTPS·자산 검사 실패 시 자동 복구합니다. 서버 검사 성공 뒤 실행기의 외부 접속만 실패했다면 성공한 서버 버전을 유지하고 Actions는 실패로 표시합니다.

Lotto는 이미지 빌드·QR 검사 → 앱 중지 → SQLite 최종 백업 → 마이그레이션 → 앱 기동 → health·HTTPS 순서입니다. 빌드 실패는 기존 앱을 유지하고 마이그레이션 실패는 배포 백업·이전 앱을 복구합니다. 새 앱 시작 후 실패하면 새 기록을 보존한 채 앱을 중지하므로 수정 후 재배포하거나 현재 DB를 백업한 뒤 호환되는 이전 DB·앱을 수동 복구합니다. 최초 실패도 DB를 지우지 않습니다.

## 9. 환경값·도메인 변경과 운영

### 앱 환경값 변경

**서버 SSH:** 해당 앱 설정을 백업하고 필요한 줄만 편집합니다.

```bash
cd /opt/mintwool/lotto  # Tools는 /opt/mintwool/tools
cp -p .env ".env.backup-$(date +%Y%m%d-%H%M%S)"
nano .env
```

`Ctrl+O → Enter → Ctrl+X`로 저장하고 해당 Actions를 `main`으로 재배포합니다. 코드 변경이 없으면 커밋이 필요 없습니다. Lotto 해시의 작은따옴표를 유지합니다. Tools AI 키·모델·작업 제한도 서버 파일에서 바꿉니다. 이미 생성한 계정은 환경변수로 바뀌지 않습니다.

Lotto 릴리스 `.env`는 루트 설정을 가리키며 Tools는 다음 배포에서 루트 설정을 복사합니다. `restart`만으로 새 환경값이 적용되지 않으므로 **재배포를 완료**합니다. 호스트 포트는 Lotto 3000·Tools 3001을 유지하며 바꾸려면 Caddy upstream도 맞춥니다.

### 운영 도메인 변경

설치 스크립트를 다른 도메인으로 재실행하지 않고 다음을 모두 맞춥니다.

1. 새 도메인의 A 레코드를 현재 서버로 연결하고 DNS only·AAAA를 확인합니다.
2. `sudo cp -p /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup-$(date +%Y%m%d-%H%M%S)"` 후 `sudo nano /etc/caddy/Caddyfile`로 사이트 이름을 바꿉니다. **Tools CSP의 `wss://기존도메인`도 새 도메인으로 바꿉니다.**
3. 앱 `.env`를 백업한 뒤 Lotto의 `APP_DOMAIN`·`APP_ORIGIN` 또는 Tools의 `DOMAIN`을 맞춥니다. `sudo nano /opt/mintwool/.setup-config`의 해당 도메인도 맞춥니다. 이전 설치에 기록 파일이 없다면 설치 스크립트를 재실행하지 않고 현재 앱·프록시 설정을 관리합니다.
4. `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 성공 후 `sudo systemctl reload caddy`를 실행합니다.
5. 해당 저장소 Variable `APP_DOMAIN`을 바꾸고 재배포합니다. 새 HTTPS·health·로그인·Tools P2P를 확인합니다.

서버 교체는 새 서버 설치·공개키 등록 후 `OCI_HOST`·사용자·포트·**새 `OCI_SSH_KNOWN_HOSTS`**를 갱신합니다. 새 Lotto 서버에 `.env`가 없으면 Bootstrap도 다시 준비합니다. DNS만 바꾸면 기존 DB·업로드·계정이 이전되지 않습니다. 원본 서버의 백업을 확보해 별도로 복원합니다.

### 상태 확인과 영구 저장

**서버 SSH:**

```bash
cd /opt/mintwool/lotto/current  # Tools는 /opt/mintwool/tools/current
sh scripts/compose.sh ps
sh scripts/compose.sh logs --tail=100 app
sudo journalctl -u caddy --no-pager -n 100
```

수동 재기동은 `sh scripts/compose.sh up -d --no-build --pull never app`입니다. 모든 서비스를 올리는 `docker compose up -d`는 공용 Caddy와 충돌할 수 있으며 `docker compose down -v`는 데이터를 지웁니다.

| 용도 | 유지 위치 |
|---|---|
| 코드·설정 | 앱별 `.env`, `releases/`, `current`, `previous` |
| Lotto DB·백업 | 프로젝트 `lotto-note`의 `app_data`·`app_backups` 영구 볼륨 |
| Tools 계정·보관함 | 프로젝트 `doguham`의 `private_data` 영구 볼륨 |
| Caddy 인증서 | 서버 `/var/lib/caddy` |

Lotto는 매일 한국 시간 03:30에 온라인 SQLite 백업을 만들고 최근 14개를 유지하며 배포 스냅샷은 별도로 보존합니다. 개인 기록 JSON은 사이트 설정에서 내려받습니다. Tools는 계정 DB·보관함 원본·결과를 앱 중지 상태에서 함께 백업합니다. VM 밖에도 백업을 보관하고 자동 정리되지 않는 릴리스·이미지의 디스크 사용량을 확인합니다.

## 10. 문제 해결과 검증 범위

| 증상 | 확인할 항목 |
|---|---|
| `Missing ...` | 선택한 저장소의 Repository 설정 이름·등록 위치 |
| `Permission denied (publickey)` | 키 쌍·사용자·개인키 전체·암호 없는 배포 키 |
| `Host key verification failed` | 실제 서버 공개 호스트 키·지문·주소·포트 |
| SSH 시간 초과 | 공인 IP·인터넷 경로·공용 서브넷·실행기 SSH 허용 |
| Docker·sudo 실패 | 4단계 설치·SSH 재접속·`sudo -n true`·`docker info` |
| 설치 중 기존 서비스·폴더 충돌 | 새 VM인지 확인. 기존 서비스·볼륨을 지워 해결하지 않고 구조 검토 |
| 설치 기록 불일치 | 기존 모드·도메인·사용자 확인, 도메인은 9단계로 변경 |
| 배포 전 502 | TLS 정상이면 첫 앱 배포 진행 |
| 배포 후 502 | app health·로그·Caddy localhost upstream 3000/3001 |
| DNS·HTTPS 실패 | A·AAAA·DNS only·80/443·시간·Caddy 로그 |
| Tools P2P 실패 | 실제 도메인과 Caddy CSP의 WSS 이름 일치 |
| 잘못된 배포 경로 | 앱별 고정 폴더·소유권·심볼릭 링크·`..` |
| Lotto 최초 `.env` 누락 | 실제 `.env.oci` 전체를 Bootstrap Secret에 등록했는지 |
| 잠금 대기 | 진행 중 배포 완료 후 재실행 |

`OCI/tests/run-tests.sh`는 개발·CI의 일회용 Docker 컨테이너에서 세 모드·두 아키텍처 분기를 검사합니다. 사용자 지정 도메인·WSS·앱 선택, 입력·기존 서비스·심볼릭 링크 거부, `.env`·잠금 보존, Caddy 실패 복구를 확인하고 렌더링한 설정을 실제 Caddy로 검증합니다. **운영 서버에서 fixture 파일을 직접 실행하지 않습니다.**

실제 앱 배포·HTTPS·health·영구 볼륨은 OCI ARM64에서 확인한 방식입니다. fixture의 ARM64 분기는 아키텍처 검사를 모의하며, 모든 신규 VM·DNS 업체의 실제 최초 설치와 인증서 발급을 대신하지 않습니다.
