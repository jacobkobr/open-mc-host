# Oracle Cloud deployment

This runbook deploys Open MC Host to an Oracle Cloud Infrastructure (OCI) Ubuntu 24.04 VM. Minecraft ports are public; the dashboard remains bound to `127.0.0.1` unless you deliberately put HTTPS or Tailscale in front of it.

## 1. Create the VM

Recommended Always Free-compatible starting point:

- Image: Canonical Ubuntu 24.04
- Shape: `VM.Standard.A1.Flex`
- Capacity: 2 OCPUs and 12 GB RAM
- Boot volume: at least 50 GB
- Networking: public subnet with an automatically assigned public IPv4 address
- SSH: upload or paste your own public key

Keep the private key on your computer. Do not paste it into Open MC Host or upload it to the VM.

## 2. Configure OCI ingress

In the OCI console, open **Networking → Virtual cloud networks → your VCN → your public subnet → Security lists → the attached security list → Add ingress rules**.

Add these rules:

| Purpose | Source CIDR | Protocol | Destination ports |
| --- | --- | --- | --- |
| Owner SSH | your current public IP with `/32` | TCP | `22` |
| Minecraft servers | `0.0.0.0/0` | TCP | `25565-25575` |

Do **not** add an ingress rule for port `3000`. The Compose configuration publishes the dashboard only on `127.0.0.1`.

If you later choose the public Caddy option, also allow TCP `80` and `443`. Tailscale does not require those public dashboard rules.

OCI security rules and the VM firewall are separate controls. If UFW is active, allow only the game range:

```sh
sudo ufw allow 25565:25575/tcp
sudo ufw status
```

Do not enable or reload UFW remotely until SSH port `22` is allowed.

## 3. Connect to the VM

From Windows PowerShell:

```powershell
ssh -i "$env:USERPROFILE\.ssh\openmchost_oci" ubuntu@YOUR_PUBLIC_IP
```

Accept the host fingerprint only after confirming it in the OCI console. The Ubuntu image login is `ubuntu`, not your OCI account name.

## 4. Install Open MC Host

```sh
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/jacobkobr/open-mc-host.git
cd open-mc-host
sudo bash scripts/deploy-oracle.sh
```

The installer:

- installs Docker Engine and Compose when necessary
- creates `/var/lib/open-mc-host` for persistent state and worlds
- creates a private `.env` with a random owner token when one does not exist
- refreshes the VM private VNIC address and selects cloud-specific connection guidance
- builds and starts the dashboard
- verifies `http://127.0.0.1:3000/api/v1/health`

The health endpoint is plain HTTP because TLS terminates in Caddy or Tailscale, not in the Node process. `https://127.0.0.1:3000` will fail with a TLS “wrong version number” error.

Read the initial owner token on the VM:

```sh
sudo sed -n 's/^MC_HOST_API_TOKEN=//p' .env
```

Treat this token like an administrator password. Do not send it to friends. Create their invite or scoped access key from the **Access** page instead.

## 5. Open the owner dashboard safely

The quickest owner-only method is an SSH tunnel. Keep this PowerShell session open:

```powershell
ssh -N -L 3000:127.0.0.1:3000 -i "$env:USERPROFILE\.ssh\openmchost_oci" ubuntu@YOUR_PUBLIC_IP
```

Then open `http://127.0.0.1:3000` locally and paste the owner token.

## 6. Let friends use the dashboard

Friends should receive an Open MC Host account or scoped access key, never the owner token and never membership in the VM's `sudo` or `docker` groups.

### Option A: Tailscale (recommended for a private panel)

Install Tailscale on the VM and sign it into your tailnet:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg http://127.0.0.1:3000
sudo tailscale serve status
```

Invite the friend to the tailnet, share the generated `https://...ts.net` URL, and give them only their own Open MC Host invite/access key. Tailscale Serve keeps port `3000` private and provides HTTPS inside the tailnet.

### Option B: public HTTPS with Caddy

Use a domain whose `A` record points to the VM's public IPv4 address. Open OCI TCP ports `80` and `443`, install Caddy from its official packages, and install the example configuration:

```sh
sudo install -m 0644 Caddyfile.example /etc/caddy/Caddyfile
sudo editor /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Replace `panel.yourdomain.com` before reloading. Caddy handles TLS and proxies to the loopback-only panel. Open MC Host authentication still applies, so create a unique scoped key for every friend and revoke it individually when necessary.

After Caddy reports an active certificate, save the same origin in Open MC Host. This makes every new invite use the correct address instead of the owner's local SSH tunnel:

```sh
sudo bash scripts/deploy-oracle.sh --dashboard-url https://panel.yourdomain.com
```

You can also paste that URL into **Settings â†’ Canonical HTTPS dashboard URL**. The URL must be HTTPS and have no path. Do not share an invite until this is configured; `localhost` is only valid on the owner's computer.

Do not publish the dashboard directly with `0.0.0.0:3000` and do not add OCI ingress for port `3000`.

### Optional restricted SSH menu

The restricted gateway is for users who prefer a terminal menu. It does not provide a shell, SCP/SFTP, port forwarding, `sudo`, or Docker access. Install it only after Node.js 20 or newer is available on the VM:

```sh
sudo bash scripts/install-ssh-gateway.sh \
  --app-dir "$(pwd)" \
  --data-dir /var/lib/open-mc-host \
  --app-user ubuntu
```

Add each friend's public SSH key through Open MC Host. Never create unrestricted Linux accounts as a substitute for dashboard roles.

They connect with `ssh openmchost@YOUR_PUBLIC_IP`. Prefer the VM's Tailscale address; otherwise add only that friend's current `/32` address to the OCI SSH ingress rule instead of opening SSH to the entire internet.

## 7. Create a server and connect

1. Create a server in the dashboard. Automatic allocation uses the configured `25565-25575` range.
2. Start it and wait for the server log to report `Done`.
3. Copy the **Public internet address** from **Player connection**.
4. Give the exact `PUBLIC_IPV4:PORT` address to friends.

The **Private address** is the VM VNIC address used by Oracle networking. It is refreshed by the deploy script and is not the address friends enter in Minecraft.

For example, if the VM public IP is `203.0.113.10` and the server uses `25565`, friends join `203.0.113.10:25565`. `localhost`, `127.0.0.1`, and the VM's private `10.x.x.x` address are not public join addresses.

A running container proves only that the game is running locally. Open MC Host reports **Publicly reachable** only after its external connectivity evidence succeeds; **Public port not confirmed** means re-check the OCI security rule and the selected game port.

## 8. Update

Commit or stash local changes before updating:

```sh
cd ~/open-mc-host
sudo bash scripts/deploy-oracle.sh --update
```

The updater performs a fast-forward-only pull, rebuilds the panel, preserves `/var/lib/open-mc-host`, and checks the HTTP health endpoint.

## 9. Back up and restore

Use the dashboard backup action for each Minecraft server first. For a full disaster-recovery snapshot, stop game servers from the dashboard and run:

```sh
sudo docker compose stop
sudo tar -C /var/lib -czf "/home/ubuntu/open-mc-host-$(date +%Y%m%d-%H%M%S).tar.gz" open-mc-host
sudo docker compose up -d
```

Copy the archive off the VM. A backup stored only on the same boot volume is not disaster recovery.

Restore to an empty data directory only while the panel and game containers are stopped:

```sh
sudo docker compose down
sudo mv /var/lib/open-mc-host /var/lib/open-mc-host.before-restore
sudo tar -C /var/lib -xzf /home/ubuntu/YOUR_BACKUP.tar.gz
sudo docker compose up -d
```

## Diagnostics

```sh
sudo docker compose ps
sudo docker compose logs --tail=200 panel
curl -fsS http://127.0.0.1:3000/api/v1/health
sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
sudo ss -lntp | grep -E ':(3000|2556[5-9]|2557[0-5])\b'
```

If Minecraft works locally but times out remotely, verify that the server's assigned port is in both the Docker publication and the OCI ingress range. Do not expose the dashboard while troubleshooting a game-port rule.

## References

- [OCI security list rules](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securitylists.htm)
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
