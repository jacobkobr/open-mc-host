# Open MC Host

Open MC Host is an open-source, self-hosted Minecraft control plane for running Java servers on your own Linux machine or cloud VM. It keeps worlds on disk, runs game processes in Docker, and provides a calm web dashboard for versions, content, files, backups, monitoring, player addresses, and delegated access.

## Platform capabilities

- Create, start, stop, restart, repair, and delete isolated Minecraft servers
- Run Vanilla, Paper, Purpur, Fabric, Forge, and NeoForge with persistent data
- Select exact Minecraft versions and supported Paper/Purpur builds instead of relying on `LATEST`
- Search Modrinth and Hangar with loader, platform, game-version, and release compatibility filters
- Inspect exact project versions and dependencies before installation
- Verify downloaded content with provider checksums before moving it into `mods/` or `plugins/`
- List installed mods and plugins, disable or re-enable them, and remove them safely
- Browse, upload, download, create, rename, and delete files without exposing the host filesystem
- Inspect logs, send console commands, monitor CPU, RAM, players, and uptime, and create data backups
- Detect LAN and public addresses while distinguishing local runtime health from confirmed public reachability
- Create invite-only friend accounts with roles, owned servers, quotas, scoped access, and audit history
- Optionally provide a restricted SSH action menu without a Linux shell, Docker, `sudo`, SCP, or port forwarding

## Requirements

For the recommended deployment:

- Linux host or VM
- Docker Engine with Docker Compose v2
- At least 4 GB RAM for the host and one small server; 8–12 GB is more practical

Node.js 20 or newer is needed only for source development, tests, or the optional restricted SSH gateway.

## Quick start with Docker

Create the environment file and replace the owner token with a long random value:

```sh
cp .env.example .env
openssl rand -hex 32
# Edit .env and paste the value into MC_HOST_API_TOKEN.
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/api/v1/health
```

On Windows PowerShell, use `Copy-Item .env.example .env`, edit `.env`, then run `docker compose up -d --build`.

Open `http://127.0.0.1:3000` and paste `MC_HOST_API_TOKEN`. Compose reads `.env` automatically. If the dashboard says the credential is invalid, recreate the panel after changing the value:

```sh
docker compose up -d --build --force-recreate
```

The dashboard binds to `127.0.0.1` by default. Minecraft server ports bind to `0.0.0.0` so players can reach them when the cloud firewall or home router allows the selected port.

## Run from source

The Node process does not automatically load `.env`. Export the token in the shell before starting:

```sh
export MC_HOST_API_TOKEN="replace-with-a-long-random-token"
npm start
```

PowerShell:

```powershell
$env:MC_HOST_API_TOKEN = "replace-with-a-long-random-token"
npm start
```

If no token is configured, Open MC Host generates one once, prints it to the terminal, and stores only its password hash in `.data/access.json`. Save the printed access key immediately; it cannot be recovered from the hash.

## Persistent data

`MC_HOST_HOST_DATA_DIR` must be an absolute path visible to the Docker daemon. The default Compose deployment uses `/var/lib/open-mc-host` and mounts it into both the panel and game containers.

Back up this directory in addition to using per-server dashboard backups. It contains control-plane records, worlds, configurations, installed content, access records, and audit history. Never commit `.env` or persistent data.

## Public Minecraft access

The address a friend enters is the VM or router's public address plus the server's assigned port:

```text
PUBLIC_IP:25565
```

For an Oracle VM, allow the configured TCP game range, default `25565-25575`, in the subnet security list. For a machine at home, forward each TCP port from the router to the displayed LAN address. Do not forward the dashboard port.

The Oracle deployment script refreshes `MC_HOST_LAN_IP` from the VM's active private route and sets `MC_HOST_NETWORK_MODE=cloud`, so a copied home-network address is not reused after migration. Home installations can use `MC_HOST_NETWORK_MODE=home` for router-specific guidance.

The dashboard does not claim a server is publicly reachable just because its container is running. **Public port not confirmed** means Docker may be healthy while the OCI rule, host firewall, router, carrier-grade NAT, or selected port still blocks remote players.

## Friend dashboard access

Do not share the owner token. Use **People & access** to create a one-time friend invite with the smallest appropriate role and quota. The friend chooses a username and receives a separate revocable dashboard credential.

Safe ways to transport the dashboard are:

1. **Tailscale Serve** for private HTTPS inside a tailnet.
2. **Caddy** for public HTTPS on a domain, while the panel remains on loopback.
3. **SSH local forwarding** for an owner-only maintenance session.

Never add friends to the host's `docker` or `sudo` group and never expose raw port `3000` to the internet. The optional restricted SSH gateway exposes only approved Open MC Host actions; it is not an unrestricted operating-system account.

## Oracle Cloud

The complete Ubuntu 24.04 deployment guide covers VM sizing, public-subnet rules, SSH, automatic installation, secure friend access, exact join addresses, backups, updates, and diagnostics:

- [`docs/ORACLE.md`](docs/ORACLE.md)
- Automated host setup: `sudo bash scripts/deploy-oracle.sh`
- Optional HTTPS example: [`Caddyfile.example`](Caddyfile.example)

## Configuration

For public friend dashboard access, keep the panel bound to loopback and place HTTPS Caddy in front of it. Set `MC_HOST_DASHBOARD_URL=https://panel.yourdomain.com` (or save it in **Settings**) so invite links use the public URL rather than an owner's local tunnel. See `docs/ORACLE.md` for the Oracle runbook.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MC_HOST_API_TOKEN` | generated when absent | Bootstrap owner credential |
| `MC_HOST_HOST_DATA_DIR` | `/var/lib/open-mc-host` in Compose | Persistent host directory |
| `MC_HOST_PANEL_PORT` | `3000` | Loopback dashboard port |
| `MC_HOST_IMAGE` | `itzg/minecraft-server:java25` | Base game runtime image |
| `MC_HOST_PUBLIC_HOST` | detected/blank | Public game hostname or IPv4 override |
| `MC_HOST_LAN_IP` | detected/blank | LAN address override for home port forwarding |
| `MC_HOST_NETWORK_MODE` | `auto` | Connection guidance mode: `auto`, `home`, or `cloud` |
| `MC_HOST_PORT_RANGE` | `25565-25575` | Automatic TCP game-port allocation range |
| `MC_HOST_MAX_UPLOAD_MB` | `250` | Dashboard file-upload limit |
| `MC_HOST_AUTO_BACKUP_ENABLED` | `true` | Creates one automatic backup per server daily |
| `MC_HOST_AUTO_BACKUP_HOUR` | `3` | UTC hour (0-23) at which daily backups may begin |

Leave address overrides blank unless detection is wrong. Do not put `https://`, a path, or a port in `MC_HOST_PUBLIC_HOST`.

Automatic backups run once per server each UTC day after `MC_HOST_AUTO_BACKUP_HOUR`. The scheduler persists its completed-day record, so restarting the panel does not create duplicate daily archives. Failed snapshots retry on the next scheduler check.

## Development

```sh
npm test
npm run dev
```

The application intentionally uses the Node standard library and Docker CLI for a small deployment surface. Provider downloads remain server-side, are constrained to supported HTTPS hosts, and are validated before installation.

## Security model

The control plane can create containers and mounts the Docker socket, which makes owner access equivalent to infrastructure administration. The dashboard therefore stays private by default, uses bearer credentials, limits friend permissions in the application, constrains file operations to server data roots, and separates public Minecraft ports from management access.

Use HTTPS or a private overlay network for any remote dashboard session. Rotate a credential immediately if it is exposed, keep SSH restricted to trusted source addresses, and maintain off-host backups.
