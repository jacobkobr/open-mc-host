#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="/var/lib/open-mc-host"
ENV_FILE="$APP_DIR/.env"
PORT_RANGE="25565-25575"
PUBLIC_HOST=""
DASHBOARD_URL=""
LAN_IP=""
UPDATE=0
DATA_DIR_SET=0
PORT_RANGE_SET=0
PUBLIC_HOST_SET=0
DASHBOARD_URL_SET=0
LAN_IP_SET=0

usage() {
  cat <<'EOF'
Usage: sudo bash scripts/deploy-oracle.sh [options]

Options:
  --update                 Fast-forward the Git checkout before rebuilding
  --data-dir PATH          Persistent data directory (default: /var/lib/open-mc-host)
  --port-range START-END   Published Minecraft TCP range (default: 25565-25575)
  --public-host HOST       Public Minecraft hostname or IPv4 address
  --dashboard-url URL      Public HTTPS dashboard origin for friend invite links
  --lan-ip ADDRESS         Override the detected private VNIC IPv4 address
  -h, --help               Show this help
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

is_private_ipv4() {
  local value="$1" first second third fourth
  [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r first second third fourth <<< "$value"
  (( 10#$first <= 255 && 10#$second <= 255 && 10#$third <= 255 && 10#$fourth <= 255 )) || return 1
  (( 10#$first == 10 || 10#$first == 192 && 10#$second == 168 || 10#$first == 172 && 10#$second >= 16 && 10#$second <= 31 ))
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --update)
      UPDATE=1
      shift
      ;;
    --data-dir)
      [[ $# -ge 2 ]] || die '--data-dir requires a value'
      DATA_DIR="$2"
      DATA_DIR_SET=1
      shift 2
      ;;
    --port-range)
      [[ $# -ge 2 ]] || die '--port-range requires a value'
      PORT_RANGE="$2"
      PORT_RANGE_SET=1
      shift 2
      ;;
    --public-host)
      [[ $# -ge 2 ]] || die '--public-host requires a value'
      PUBLIC_HOST="$2"
      PUBLIC_HOST_SET=1
      shift 2
      ;;
    --dashboard-url)
      [[ $# -ge 2 ]] || die '--dashboard-url requires a value'
      DASHBOARD_URL="$2"
      DASHBOARD_URL_SET=1
      shift 2
      ;;
    --lan-ip)
      [[ $# -ge 2 ]] || die '--lan-ip requires a value'
      LAN_IP="$2"
      LAN_IP_SET=1
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || die 'run this script with sudo'
[[ -f "$APP_DIR/compose.yaml" ]] || die "compose.yaml was not found in $APP_DIR"

env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

if [[ -f "$ENV_FILE" ]]; then
  if (( DATA_DIR_SET == 0 )); then
    EXISTING_DATA_DIR="$(env_value MC_HOST_HOST_DATA_DIR)"
    [[ -z "$EXISTING_DATA_DIR" ]] || DATA_DIR="$EXISTING_DATA_DIR"
  fi
  if (( PORT_RANGE_SET == 0 )); then
    EXISTING_PORT_RANGE="$(env_value MC_HOST_PORT_RANGE)"
    [[ -z "$EXISTING_PORT_RANGE" ]] || PORT_RANGE="$EXISTING_PORT_RANGE"
  fi
  if (( PUBLIC_HOST_SET == 0 )); then
    PUBLIC_HOST="$(env_value MC_HOST_PUBLIC_HOST)"
  fi
  if (( DASHBOARD_URL_SET == 0 )); then
    DASHBOARD_URL="$(env_value MC_HOST_DASHBOARD_URL)"
  fi
fi

[[ "$DATA_DIR" == /* ]] || die '--data-dir must be an absolute path'
[[ "$PORT_RANGE" =~ ^([0-9]{1,5})-([0-9]{1,5})$ ]] || die '--port-range must look like 25565-25575'

START_PORT="${BASH_REMATCH[1]}"
END_PORT="${BASH_REMATCH[2]}"
(( START_PORT >= 1024 && START_PORT <= 65535 )) || die 'the first game port must be between 1024 and 65535'
(( END_PORT >= START_PORT && END_PORT <= 65535 )) || die 'the final game port must be between the first port and 65535'
[[ "$DATA_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die '--data-dir contains unsupported characters'

if [[ -n "$PUBLIC_HOST" ]]; then
  if [[ "${PUBLIC_HOST,,}" =~ (^|\.)example\.(com|net|org)$ || "$PUBLIC_HOST" =~ ^(192\.0\.2|198\.51\.100|203\.0\.113)\.[0-9]{1,3}$ ]]; then
    if (( PUBLIC_HOST_SET == 1 )); then die '--public-host cannot use a reserved example domain'; fi
    printf 'warning: clearing reserved example public host %s\n' "$PUBLIC_HOST" >&2
    PUBLIC_HOST=""
    PUBLIC_HOST_SET=1
  fi
fi

if [[ -n "$DASHBOARD_URL" ]]; then
  DASHBOARD_URL="${DASHBOARD_URL%/}"
  [[ "$DASHBOARD_URL" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]] \
    || die '--dashboard-url must be an HTTPS origin without a path, query, or fragment'
  DASHBOARD_HOST="${DASHBOARD_URL#https://}"
  DASHBOARD_HOST="${DASHBOARD_HOST%%:*}"
  [[ ! "$DASHBOARD_HOST" =~ (^|\.)example\.(com|net|org)$ ]] \
    || die '--dashboard-url cannot use a reserved example domain'
  [[ ! "$DASHBOARD_HOST" =~ ^(localhost|127\.0\.0\.1)$ ]] \
    || die '--dashboard-url cannot use localhost'
fi
if [[ -n "$PUBLIC_HOST" ]]; then
  if [[ "$PUBLIC_HOST" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    IFS='.' read -r -a PUBLIC_HOST_OCTETS <<< "$PUBLIC_HOST"
    for octet in "${PUBLIC_HOST_OCTETS[@]}"; do
      (( 10#$octet <= 255 )) || die '--public-host contains an invalid IPv4 address'
    done
  else
    (( ${#PUBLIC_HOST} <= 253 )) || die '--public-host hostname is too long'
    [[ "$PUBLIC_HOST" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] \
      || die '--public-host must be a valid hostname or IPv4 address without a scheme, path, or port'
  fi
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || printf 'warning: this installer is tested on Ubuntu 24.04; detected %s\n' "${PRETTY_NAME:-unknown}" >&2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git openssl iproute2

if (( LAN_IP_SET == 0 )); then
  LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (field = 1; field <= NF; field += 1) if ($field == "src") { print $(field + 1); exit } }')"
fi
if [[ -n "$LAN_IP" ]]; then
  is_private_ipv4 "$LAN_IP" || die 'the detected or configured LAN IP is not a private IPv4 address'
fi

if ! command -v docker >/dev/null 2>&1; then
  if ! apt-get install -y docker.io docker-compose-v2; then
    apt-get install -y docker.io docker-compose
  fi
fi

systemctl enable --now docker

if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  if ! apt-get install -y docker-compose-v2; then
    apt-get install -y docker-compose
  fi
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die 'Docker Compose is unavailable after installation'
fi

APP_OWNER="${SUDO_USER:-root}"
id "$APP_OWNER" >/dev/null 2>&1 || APP_OWNER=root
APP_GROUP="$(id -gn "$APP_OWNER")"

if (( UPDATE == 1 )); then
  command -v git >/dev/null 2>&1 || die 'git is required for --update'
  if [[ -d "$APP_DIR/.git" ]]; then
    sudo -u "$APP_OWNER" git -C "$APP_DIR" pull --ff-only
  else
    die "$APP_DIR is not a Git checkout; update the files manually and run without --update"
  fi
fi

install -d -m 0750 "$DATA_DIR"

set_env() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "$APP_DIR/.env.XXXXXX")"
  if [[ -f "$ENV_FILE" ]]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { found = 0 }
      index($0, key "=") == 1 { print key "=" value; found = 1; next }
      { print }
      END { if (!found) print key "=" value }
    ' "$ENV_FILE" > "$temporary"
  else
    printf '%s=%s\n' "$key" "$value" > "$temporary"
  fi
  chown "$APP_OWNER:$APP_GROUP" "$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$ENV_FILE"
}

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  OWNER_TOKEN="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
PORT=3000
MC_HOST_DATA_DIR=.data
MC_HOST_IMAGE=itzg/minecraft-server:java25
MC_HOST_API_TOKEN=$OWNER_TOKEN
MC_HOST_HOST_DATA_DIR=$DATA_DIR
MC_HOST_PANEL_PORT=3000
MC_HOST_PUBLIC_HOST=$PUBLIC_HOST
MC_HOST_DASHBOARD_URL=$DASHBOARD_URL
MC_HOST_LAN_IP=$LAN_IP
MC_HOST_NETWORK_MODE=cloud
MC_HOST_PORT_RANGE=$PORT_RANGE
MC_HOST_MAX_UPLOAD_MB=250
EOF
  chown "$APP_OWNER:$APP_GROUP" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
else
  set_env MC_HOST_HOST_DATA_DIR "$DATA_DIR"
  set_env MC_HOST_PORT_RANGE "$PORT_RANGE"
  set_env MC_HOST_LAN_IP "$LAN_IP"
  set_env MC_HOST_NETWORK_MODE cloud
  if (( PUBLIC_HOST_SET == 1 )); then
    set_env MC_HOST_PUBLIC_HOST "$PUBLIC_HOST"
  fi
  if (( DASHBOARD_URL_SET == 1 )); then
    set_env MC_HOST_DASHBOARD_URL "$DASHBOARD_URL"
  fi
  if ! grep -q '^MC_HOST_API_TOKEN=.' "$ENV_FILE"; then
    set_env MC_HOST_API_TOKEN "$(openssl rand -hex 32)"
  fi
fi

PANEL_PORT="$(awk -F= '$1 == "MC_HOST_PANEL_PORT" { print $2; exit }' "$ENV_FILE")"
PANEL_PORT="${PANEL_PORT:-3000}"
[[ "$PANEL_PORT" =~ ^[0-9]{1,5}$ ]] || die 'MC_HOST_PANEL_PORT in .env must be a numeric port'

cd "$APP_DIR"
"${COMPOSE[@]}" config >/dev/null
"${COMPOSE[@]}" up -d --build --remove-orphans

HEALTH_URL="http://127.0.0.1:$PANEL_PORT/api/v1/health"
SETTINGS_URL="http://127.0.0.1:$PANEL_PORT/api/v1/settings"
update_persisted_setting() {
  local key="$1"
  local value="$2"
  local token
  token="$(sed -n 's/^MC_HOST_API_TOKEN=//p' "$ENV_FILE" | tail -n 1)"
  [[ -n "$token" ]] || die 'MC_HOST_API_TOKEN is missing from .env'
  curl -fsS -X PATCH \
    -H "Authorization: Bearer $token" \
    -H 'content-type: application/json' \
    --data "{\"$key\":\"$value\"}" \
    "$SETTINGS_URL" >/dev/null
}
for _ in $(seq 1 60); do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    if (( PUBLIC_HOST_SET == 1 )); then update_persisted_setting publicHost "$PUBLIC_HOST"; fi
    if (( DASHBOARD_URL_SET == 1 )); then update_persisted_setting dashboardUrl "$DASHBOARD_URL"; fi
    printf '\nOpen MC Host is healthy.\n'
    printf 'Dashboard: http://127.0.0.1:%s (loopback only)\n' "$PANEL_PORT"
    if [[ -n "$DASHBOARD_URL" ]]; then
      printf 'Friend dashboard URL: %s\n' "$DASHBOARD_URL"
    else
      printf 'Friend dashboard URL: configure HTTPS Caddy first, then rerun with --dashboard-url\n'
    fi
    printf 'Minecraft TCP range: %s\n' "$PORT_RANGE"
    printf 'Owner token: sudo sed -n '\''s/^MC_HOST_API_TOKEN=//p'\'' %q\n' "$ENV_FILE"
    printf '\nOCI must allow TCP %s to this VM. Do not expose dashboard port %s.\n' "$PORT_RANGE" "$PANEL_PORT"
    exit 0
  fi
  sleep 2
done

"${COMPOSE[@]}" ps >&2 || true
"${COMPOSE[@]}" logs --tail=100 panel >&2 || true
die "dashboard did not become healthy at $HEALTH_URL"
