#!/bin/sh
set -eu

APP_DIR=""
DATA_DIR="/var/lib/open-mc-host"
GATEWAY_USER="openmchost"
APP_USER="${SUDO_USER:-root}"

usage() {
  echo "Usage: sudo $0 --app-dir /absolute/path/to/open-mc-host [--data-dir /var/lib/open-mc-host] [--user openmchost] [--app-user ubuntu]" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-dir) APP_DIR=${2:-}; shift 2 ;;
    --data-dir) DATA_DIR=${2:-}; shift 2 ;;
    --user) GATEWAY_USER=${2:-}; shift 2 ;;
    --app-user) APP_USER=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Run this installer with sudo." >&2; exit 1; }
[ -n "$APP_DIR" ] || usage

case "$APP_DIR:$DATA_DIR" in
  *[!A-Za-z0-9_./:-]*) echo "Application and data paths may only contain letters, numbers, dots, underscores, dashes, and slashes." >&2; exit 1 ;;
esac
case "$GATEWAY_USER:$APP_USER" in
  *[!A-Za-z0-9_-]*) echo "Linux account names are invalid." >&2; exit 1 ;;
esac
case "$APP_DIR" in /*) ;; *) echo "--app-dir must be absolute." >&2; exit 1 ;; esac
case "$DATA_DIR" in /*) ;; *) echo "--data-dir must be absolute." >&2; exit 1 ;; esac

[ -f "$APP_DIR/bin/openmchost-ssh.js" ] || { echo "Open MC Host SSH CLI not found in $APP_DIR." >&2; exit 1; }
[ -f "$APP_DIR/src/access.js" ] || { echo "Open MC Host access service not found in $APP_DIR." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js is required." >&2; exit 1; }
id "$APP_USER" >/dev/null 2>&1 || { echo "Application user $APP_USER does not exist." >&2; exit 1; }

APP_GROUP=$(id -gn "$APP_USER")

if ! id "$GATEWAY_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/$GATEWAY_USER" --shell /bin/sh "$GATEWAY_USER"
fi
passwd -l "$GATEWAY_USER" >/dev/null 2>&1 || true
usermod -a -G "$APP_GROUP" "$GATEWAY_USER"

install -d -m 2750 -o "$APP_USER" -g "$APP_GROUP" "$DATA_DIR"
if [ -f "$DATA_DIR/access.json" ]; then
  chown "$APP_USER:$APP_GROUP" "$DATA_DIR/access.json"
  chmod 0640 "$DATA_DIR/access.json"
fi
if [ ! -f "$DATA_DIR/ssh-gateway-token" ]; then
  umask 027
  openssl rand -hex 32 > "$DATA_DIR/ssh-gateway-token"
fi
chown "$APP_USER:$APP_GROUP" "$DATA_DIR/ssh-gateway-token"
chmod 0640 "$DATA_DIR/ssh-gateway-token"

install -d -m 0755 /usr/local/lib/open-mc-host /usr/local/bin /usr/local/sbin
cat > /usr/local/bin/openmchost-ssh <<EOF
#!/bin/sh
export MC_HOST_SSH_GATEWAY_URL=http://127.0.0.1:3000/api/v1/ssh
export MC_HOST_SSH_GATEWAY_TOKEN_FILE=$DATA_DIR/ssh-gateway-token
exec /usr/bin/node $APP_DIR/bin/openmchost-ssh.js "\$@"
EOF
chown root:root /usr/local/bin/openmchost-ssh
chmod 0755 /usr/local/bin/openmchost-ssh

SSH_HOME=$(getent passwd "$GATEWAY_USER" | cut -d: -f6)
chown root:root "$SSH_HOME"
chmod 0755 "$SSH_HOME"
install -d -m 0755 -o root -g root "$SSH_HOME/.ssh"
touch "$SSH_HOME/.ssh/authorized_keys"
chown root:root "$SSH_HOME/.ssh/authorized_keys"
chmod 0600 "$SSH_HOME/.ssh/authorized_keys"

cat > /usr/local/sbin/openmchost-sync-ssh-keys <<EOF
#!/bin/sh
set -eu
TEMP_FILE=\$(mktemp /tmp/openmchost-authorized-keys.XXXXXX)
trap 'rm -f "\$TEMP_FILE"' EXIT
/usr/bin/node $APP_DIR/bin/openmchost-ssh.js --data-dir $DATA_DIR --render-authorized-keys > "\$TEMP_FILE"
install -m 0600 -o root -g root "\$TEMP_FILE" $SSH_HOME/.ssh/authorized_keys
EOF
chown root:root /usr/local/sbin/openmchost-sync-ssh-keys
chmod 0750 /usr/local/sbin/openmchost-sync-ssh-keys

SSHD_DROPIN=/etc/ssh/sshd_config.d/90-open-mc-host.conf
install -d -m 0755 /etc/ssh/sshd_config.d
cat > "$SSHD_DROPIN" <<EOF
Match User $GATEWAY_USER
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PubkeyAuthentication yes
    AllowTcpForwarding no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    PermitTTY yes
EOF
chmod 0644 "$SSHD_DROPIN"

if command -v sshd >/dev/null 2>&1 && ! sshd -t; then
  rm -f "$SSHD_DROPIN"
  echo "The SSH configuration check failed; the Open MC Host SSH drop-in was removed." >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/openmchost-ssh-keys.service <<EOF
[Unit]
Description=Synchronize Open MC Host restricted SSH keys

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/openmchost-sync-ssh-keys
EOF
  cat > /etc/systemd/system/openmchost-ssh-keys.path <<EOF
[Unit]
Description=Watch Open MC Host access records

[Path]
PathChanged=$DATA_DIR/access.json
Unit=openmchost-ssh-keys.service

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now openmchost-ssh-keys.path
fi

/usr/local/sbin/openmchost-sync-ssh-keys
if command -v systemctl >/dev/null 2>&1; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
fi

echo "Restricted SSH gateway installed for account: $GATEWAY_USER"
echo "Friends use: ssh $GATEWAY_USER@YOUR_SERVER_IP"
echo "No password, shell, sudo, Docker, or port forwarding access is enabled."
