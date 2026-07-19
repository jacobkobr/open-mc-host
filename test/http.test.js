const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHandler } = require('../src/http');
const { AccessService } = require('../src/access');
const { normalizePublicHost, normalizeDashboardUrl } = require('../src/settings');

async function start() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-mc-host-http-'));
  const token = 'test-owner-token-that-is-long-enough-1234567890';
  const access = new AccessService({ dataDir, ownerToken: token });
  await access.initialize();
  const service = {
    catalog: () => ({ software: [{ id: 'PAPER' }] }),
    list: async () => []
  };
  const runtime = { nodeStatus: async () => ({ runtime: 'docker' }) };
  const settings = {
    value: { publicHost: '', dashboardUrl: '' },
    async get() { return this.value; },
    async setPublicHost(publicHost) { this.value = { ...this.value, publicHost: normalizePublicHost(publicHost) }; return this.value; },
    async setDashboardUrl(dashboardUrl) { this.value = { ...this.value, dashboardUrl: normalizeDashboardUrl(dashboardUrl) }; return this.value; }
  };
  const server = http.createServer(createHandler({ access, service, runtime, settings, publicDir: path.join(__dirname, '..', 'public') }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, token, url: `http://127.0.0.1:${server.address().port}` };
}

test('protects control-plane routes while exposing health', async (context) => {
  const { server, token, url } = await start();
  context.after(() => server.close());
  assert.equal((await fetch(`${url}/api/v1/health`)).status, 200);
  assert.equal((await fetch(`${url}/assets/logo.png`)).status, 200);
  assert.equal((await fetch(`${url}/assets/lucide/sun.svg`)).status, 200);
  assert.equal((await fetch(`${url}/assets/lucide/moon.svg`)).status, 200);
  assert.equal((await fetch(`${url}/assets/lucide/panel-left-close.svg`)).status, 200);
  assert.equal((await fetch(`${url}/api/v1/catalog`)).status, 401);
  const response = await fetch(`${url}/api/v1/catalog`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).software[0].id, 'PAPER');
  const settings = await fetch(`${url}/api/v1/settings`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ publicHost: 'mc.yourdomain.com' }) });
  assert.equal((await settings.json()).publicHost, 'mc.yourdomain.com');
  const reservedSettings = await fetch(`${url}/api/v1/settings`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ publicHost: 'mc.example.com' }) });
  assert.equal(reservedSettings.status, 400);
  const dashboard = await fetch(`${url}/api/v1/settings`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ dashboardUrl: 'https://panel.yourdomain.com/' }) });
  assert.equal((await dashboard.json()).dashboardUrl, 'https://panel.yourdomain.com');
  assert.equal((await fetch(`${url}/api/v1/servers/server-id/modrinth`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await fetch(`${url}/api/v1/servers/server-id/modrinth/modpack`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status, 404);
});
