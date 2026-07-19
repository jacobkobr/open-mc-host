const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AccessService } = require('../src/access');
const { createHandler } = require('../src/http');

async function start() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-mc-host-http-access-'));
  const ownerToken = 'owner-token-that-is-long-enough-for-secure-bootstrap';
  const access = new AccessService({ dataDir, ownerToken });
  const bootstrap = await access.initialize();
  let listedBy = null;
  const service = {
    catalog: () => ({ software: [{ id: 'PAPER' }] }),
    async list(principal) { listedBy = principal; return []; }
  };
  const runtime = { async nodeStatus() { return { runtime: 'docker' }; } };
  const settings = {
    value: { publicHost: '' },
    async get() { return this.value; },
    async connectionStatus() { return { configured: false, state: 'missing', addresses: [] }; },
    async setPublicHost(publicHost) { this.value = { publicHost }; return this.value; }
  };
  const server = http.createServer(createHandler({ access, service, runtime, settings, sshGatewayToken: 'internal-gateway-token-that-is-long-enough', publicDir: path.join(__dirname, '..', 'public') }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { access, bootstrap, ownerToken, server, get listedBy() { return listedBy; }, url: `http://127.0.0.1:${server.address().port}` };
}

function bearer(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

test('supports invite-only dashboard login and owner-only settings', async (context) => {
  const fixture = await start();
  context.after(() => fixture.server.close());

  assert.equal((await fetch(`${fixture.url}/api/v1/me`)).status, 401);
  const owner = await fetch(`${fixture.url}/api/v1/me`, { headers: bearer(fixture.ownerToken) });
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).role, 'owner');

  const inviteResponse = await fetch(`${fixture.url}/api/v1/access/invites`, {
    method: 'POST', headers: bearer(fixture.ownerToken),
    body: JSON.stringify({ role: 'member', quotas: { maxServers: 1, maxMemoryMiB: 4096, maxStorageBytes: 1024 }, expiresInHours: 24 })
  });
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();

  const redeemedResponse = await fetch(`${fixture.url}/api/v1/access/invites/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, username: 'friend', displayName: 'Friend', credentialLabel: 'Browser' })
  });
  assert.equal(redeemedResponse.status, 201);
  const redeemed = await redeemedResponse.json();

  const memberList = await fetch(`${fixture.url}/api/v1/servers`, { headers: bearer(redeemed.credential) });
  assert.equal(memberList.status, 200);
  assert.equal(fixture.listedBy.username, 'friend');
  const denied = await fetch(`${fixture.url}/api/v1/settings`, { method: 'PATCH', headers: bearer(redeemed.credential), body: JSON.stringify({ publicHost: 'example.net' }) });
  assert.equal(denied.status, 403);

  const replacementResponse = await fetch(`${fixture.url}/api/v1/access/principals/${redeemed.principal.id}/credentials`, { method: 'POST', headers: bearer(fixture.ownerToken), body: JSON.stringify({ label: 'Recovery key' }) });
  assert.equal(replacementResponse.status, 201);
  const replacement = await replacementResponse.json();
  const credentialListResponse = await fetch(`${fixture.url}/api/v1/access/principals/${redeemed.principal.id}/credentials`, { headers: bearer(fixture.ownerToken) });
  assert.equal(credentialListResponse.status, 200);
  const credentials = await credentialListResponse.json();
  assert.ok(credentials.some((credential) => credential.id === replacement.id && credential.label === 'Recovery key'));
  assert.equal(JSON.stringify(credentials).includes(replacement.token), false);
  const revokeResponse = await fetch(`${fixture.url}/api/v1/access/principals/${redeemed.principal.id}/credentials/${replacement.id}`, { method: 'DELETE', headers: bearer(fixture.ownerToken) });
  assert.equal(revokeResponse.status, 204);
  const restoreResponse = await fetch(`${fixture.url}/api/v1/access/principals/${redeemed.principal.id}/credentials/${replacement.id}`, { method: 'PATCH', headers: bearer(fixture.ownerToken) });
  assert.equal(restoreResponse.status, 200);
  assert.equal((await restoreResponse.json()).revokedAt, null);
  const deleteResponse = await fetch(`${fixture.url}/api/v1/access/principals/${redeemed.principal.id}/credentials/${replacement.id}/delete`, { method: 'POST', headers: bearer(fixture.ownerToken) });
  assert.equal(deleteResponse.status, 204);
});

test('keeps the restricted SSH action endpoint loopback-only and separately authenticated', async (context) => {
  const fixture = await start();
  context.after(() => fixture.server.close());
  const denied = await fetch(`${fixture.url}/api/v1/ssh/actions`, { method: 'POST', headers: bearer(fixture.ownerToken), body: JSON.stringify({ principalId: fixture.bootstrap.principal.id, action: 'servers.list', args: {} }) });
  assert.equal(denied.status, 403);
  const allowed = await fetch(`${fixture.url}/api/v1/ssh/actions`, { method: 'POST', headers: bearer('internal-gateway-token-that-is-long-enough'), body: JSON.stringify({ principalId: fixture.bootstrap.principal.id, action: 'servers.list', args: {} }) });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), []);
});
