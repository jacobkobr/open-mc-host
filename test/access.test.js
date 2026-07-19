const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AccessService } = require('../src/access');
const { RestrictedGatewayClient, assertLoopbackUrl, parseCommand, runCommand } = require('../bin/openmchost-ssh');

async function fixture(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-mc-host-access-'));
  const access = new AccessService({ dataDir, ...options });
  const bootstrap = await access.initialize();
  return { access, bootstrap, dataDir };
}

async function createMember(access, ownerId, options = {}) {
  const invite = await access.createInvite(ownerId, { role: options.role || 'member', quotas: options.quotas || {}, expiresInHours: 24 });
  return access.redeemInvite(invite.code, { username: options.username || 'friend', displayName: options.displayName || 'Friendly User' });
}

test('bootstraps an owner with a hashed bearer credential', async () => {
  const { access, bootstrap, dataDir } = await fixture();
  assert.equal(bootstrap.created, true);
  assert.match(bootstrap.credential, /^omh_/);
  assert.equal((await access.authenticate(bootstrap.credential)).role, 'owner');
  assert.equal(await access.authenticate('wrong-token'), null);
  assert.equal(await access.authenticate(null), null);

  const stored = await fs.readFile(path.join(dataDir, 'access.json'), 'utf8');
  assert.equal(stored.includes(bootstrap.credential), false);
  assert.match(stored, /"secretHash"/);
  assert.equal((await access.initialize()).created, false);
});

test('accepts an existing long owner token without storing it', async () => {
  const ownerToken = 'existing-owner-token-that-is-long-enough-1234567890';
  const { access, bootstrap, dataDir } = await fixture({ ownerToken });
  assert.equal(bootstrap.credential, null);
  assert.equal((await access.authenticate(ownerToken)).username, 'owner');
  assert.equal((await fs.readFile(path.join(dataDir, 'access.json'), 'utf8')).includes(ownerToken), false);
});

test('rotates the environment-managed owner recovery token on restart', async () => {
  const firstToken = 'first-environment-owner-token-123456789012345';
  const secondToken = 'second-environment-owner-token-12345678901234';
  const { access, dataDir } = await fixture({ ownerToken: firstToken });
  assert.equal((await access.authenticate(firstToken)).role, 'owner');
  const restarted = new AccessService({ dataDir, ownerToken: secondToken });
  const result = await restarted.initialize();
  assert.equal(result.rotated, true);
  assert.equal(await restarted.authenticate(firstToken), null);
  assert.equal((await restarted.authenticate(secondToken)).role, 'owner');
});

test('redeems one-time invites and enforces member quotas serially', async () => {
  const { access, bootstrap } = await fixture();
  const invite = await access.createInvite(bootstrap.principal.id, { role: 'member', quotas: { maxServers: 1, maxMemoryMiB: 2048, maxStorageBytes: 1024 }, expiresInHours: 1 });
  const member = await access.redeemInvite(invite.code, { username: 'alex', displayName: 'Alex' });
  assert.equal((await access.authenticate(member.credential)).id, member.principal.id);
  await assert.rejects(() => access.redeemInvite(invite.code, { username: 'other', displayName: 'Other' }), { status: 401 });

  const attempts = await Promise.allSettled([
    access.registerServer(member.principal.id, { serverId: 'one', memoryMiB: 2048, storageBytes: 512 }),
    access.registerServer(member.principal.id, { serverId: 'two', memoryMiB: 2048, storageBytes: 512 })
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await access.checkQuota(member.principal.id)).usage.servers, 1);
});

test('applies ownership and scoped server grants', async () => {
  const { access, bootstrap } = await fixture();
  const member = await createMember(access, bootstrap.principal.id, { username: 'builder' });
  const viewer = await createMember(access, bootstrap.principal.id, { username: 'watcher', role: 'viewer' });
  await access.registerServer(bootstrap.principal.id, { serverId: 'survival', ownerId: bootstrap.principal.id, memoryMiB: 4096 });
  await access.grantServer(bootstrap.principal.id, { serverId: 'survival', principalId: member.principal.id, level: 'operate' });
  await access.grantServer(bootstrap.principal.id, { serverId: 'survival', principalId: viewer.principal.id, level: 'manage' });

  assert.equal(await access.can(member.principal.id, 'server.read', 'survival'), true);
  assert.equal(await access.can(member.principal.id, 'server.control', 'survival'), true);
  assert.equal(await access.can(member.principal.id, 'server.files', 'survival'), false);
  assert.equal(await access.can(viewer.principal.id, 'server.read', 'survival'), true);
  assert.equal(await access.can(viewer.principal.id, 'server.control', 'survival'), false);
  assert.equal(await access.can(bootstrap.principal.id, 'made.up.action', 'survival'), false);
  assert.equal((await access.listServerGrants(bootstrap.principal.id, 'survival')).length, 2);
  assert.deepEqual((await access.listShareCandidates(bootstrap.principal.id, 'survival')).map((item) => item.username).sort(), ['builder', 'watcher']);
  await assert.rejects(() => access.assertAuthorized(member.principal.id, 'server.delete', 'survival'), { status: 403 });
});

test('enforces aggregate storage quotas for managed servers', async () => {
  const { access, bootstrap } = await fixture();
  const member = await createMember(access, bootstrap.principal.id, { username: 'storage', quotas: { maxServers: 1, maxMemoryMiB: 4096, maxStorageBytes: 100 } });
  await access.registerServer(member.principal.id, { serverId: 'storage-world', memoryMiB: 2048, storageBytes: 10 });
  const usage = await access.updateServerStorage(member.principal.id, 'storage-world', 90);
  assert.equal(usage.storageBytes, 90);
  await assert.rejects(() => access.updateServerStorage(member.principal.id, 'storage-world', 101), { status: 409 });
  assert.equal((await access.checkQuota(member.principal.id)).usage.storageBytes, 90);
});

test('registers SSH keys and renders forced-command authorized_keys', async () => {
  const { access, bootstrap, dataDir } = await fixture();
  const member = await createMember(access, bootstrap.principal.id, { username: 'sshfriend' });
  const keyBody = Buffer.alloc(48, 7).toString('base64');
  const key = await access.addSshKey(member.principal.id, { publicKey: `ssh-ed25519 ${keyBody} friend@laptop`, label: 'Laptop' });
  assert.match(key.fingerprint, /^SHA256:/);
  const authorized = await access.renderAuthorizedKeys({ command: '/usr/local/bin/openmchost-ssh', dataDir: '/var/lib/open-mc-host' });
  assert.match(authorized, new RegExp(`--principal ${member.principal.id}`));
  assert.match(authorized, /no-port-forwarding/);
  assert.match(authorized, /no-agent-forwarding/);
  assert.doesNotMatch(authorized, /sudo|docker/);
  await assert.rejects(() => access.addSshKey(bootstrap.principal.id, { publicKey: `ssh-ed25519 ${keyBody} duplicate`, label: 'Duplicate' }), { status: 409 });
});

test('records security-relevant audit events without credentials', async () => {
  const { access, bootstrap } = await fixture();
  const invite = await access.createInvite(bootstrap.principal.id, { role: 'operator' });
  const operator = await access.redeemInvite(invite.code, { username: 'operator', displayName: 'Operator' });
  const events = await access.listAuditEvents(bootstrap.principal.id);
  assert.ok(events.some((event) => event.action === 'invite.created'));
  assert.ok(events.some((event) => event.action === 'invite.claimed' && event.principalId === operator.principal.id));
  assert.equal(JSON.stringify(events).includes(invite.code), false);
  assert.equal(JSON.stringify(events).includes(operator.credential), false);
});

test('lists quota usage and safe revocable credential metadata for owners', async () => {
  const { access, bootstrap } = await fixture();
  const member = await createMember(access, bootstrap.principal.id, { username: 'credential-user' });
  const created = await access.createCredential(bootstrap.principal.id, { principalId: member.principal.id, label: 'Replacement dashboard' });
  const principals = await access.listPrincipals(bootstrap.principal.id);
  assert.equal(principals.find((item) => item.id === member.principal.id).quota.usage.servers, 0);
  const credentials = await access.listCredentials(bootstrap.principal.id, member.principal.id);
  assert.ok(credentials.some((credential) => credential.id === created.id && credential.label === 'Replacement dashboard'));
  assert.ok(credentials.every((credential) => !('secretHash' in credential) && !('secretSalt' in credential)));
  await access.revokeCredential(bootstrap.principal.id, member.principal.id, created.id);
  assert.ok((await access.listCredentials(bootstrap.principal.id, member.principal.id)).find((credential) => credential.id === created.id).revokedAt);
  await access.restoreCredential(bootstrap.principal.id, member.principal.id, created.id);
  assert.equal((await access.listCredentials(bootstrap.principal.id, member.principal.id)).find((credential) => credential.id === created.id).revokedAt, null);
  assert.equal((await access.authenticate(created.token)).id, member.principal.id);
  await access.deleteCredential(bootstrap.principal.id, member.principal.id, created.id);
  assert.equal((await access.listCredentials(bootstrap.principal.id, member.principal.id)).some((credential) => credential.id === created.id), false);
  assert.equal(await access.authenticate(created.token), null);
});

test('restricted SSH parser rejects arbitrary commands and shell syntax', () => {
  assert.deepEqual(parseCommand('start abc-123'), { kind: 'remote', action: 'servers.start', args: { serverId: 'abc-123' } });
  assert.deepEqual(parseCommand('create skyblock PAPER 1.21.4 4G'), { kind: 'remote', action: 'servers.create', args: { name: 'skyblock', software: 'PAPER', version: '1.21.4', memory: '4G' } });
  for (const input of ['bash', 'sh', 'sudo docker ps', 'servers; id', 'status x && cat /etc/passwd', '$(id)', '`id`', 'cat /etc/passwd']) {
    assert.throws(() => parseCommand(input), { status: 403 });
  }
  assert.equal(assertLoopbackUrl('http://127.0.0.1:3000/api').hostname, '127.0.0.1');
  assert.throws(() => assertLoopbackUrl('https://example.com/api'), { status: 500 });
});

test('restricted SSH client only sends whitelisted actions to loopback', async () => {
  const { access, bootstrap, dataDir } = await fixture();
  const tokenFile = path.join(dataDir, 'gateway-token');
  await fs.writeFile(tokenFile, 'a-secure-internal-token-with-32-characters');
  let request;
  const client = new RestrictedGatewayClient({
    tokenFile,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, status: 200, async json() { return []; } };
    }
  });
  const result = await runCommand(parseCommand('servers'), { access, client, principalId: bootstrap.principal.id });
  assert.equal(result, 'No servers yet.');
  assert.equal(request.url, 'http://127.0.0.1:3000/api/v1/ssh/actions');
  assert.equal(JSON.parse(request.options.body).action, 'servers.list');
  await assert.rejects(() => client.execute(bootstrap.principal.id, 'shell.exec', {}), { status: 403 });
});
