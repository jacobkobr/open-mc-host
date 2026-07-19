const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { ServerStore } = require('../src/store');
const { ServerService, validate } = require('../src/service');

class FakeRuntime {
  constructor(dataDir) { this.dataDir = dataDir; this.states = new Map(); this.commands = []; this.restores = []; this.logRequests = []; }
  serverDir(server) { return path.join(this.dataDir, 'servers', server.id); }
  async create(server) { this.states.set(server.id, 'running'); }
  async status(server) { return this.states.get(server.id) || 'missing'; }
  async start(server) { this.states.set(server.id, 'running'); }
  async stop(server) { this.states.set(server.id, 'exited'); }
  async restart(server) { this.states.set(server.id, 'running'); }
  async remove(server) { this.states.delete(server.id); }
  async startedAt() { return '2026-07-18T12:00:00.000Z'; }
  async logs(server, tail, range) { this.logRequests.push({ server, tail, range }); return 'ready'; }
  async metrics() { return { CPUPerc: '1.2%', MemUsage: '100MiB / 2GiB' }; }
  async command(server, command) { this.commands.push({ server, command }); }
  async backup(server, destination) { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, server.id); }
  async restore(server, backupPath) { this.restores.push({ server, backupPath }); }
}

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-mc-host-'));
  const store = new ServerStore(dataDir);
  await store.initialize();
  const modrinth = {};
  return { dataDir, runtime: new FakeRuntime(dataDir), store, modrinth };
}

test('validates Java server settings', () => {
  assert.deepEqual(validate({ name: 'Survival', software: 'paper', version: '1.21.4', memory: '4g', port: 25565 }), { name: 'Survival', software: 'PAPER', version: '1.21.4', build: '', memory: '4G', cpus: 1, port: 25565 });
  assert.throws(() => validate({ name: 'x' }));
  assert.throws(() => validate({ name: 'Good name', memory: 'a lot' }));
});

test('installs a Modrinth modpack while the server is stopped', async () => {
  const { dataDir, runtime, store, modrinth } = await fixture();
  const artifact = Buffer.from('verified modpack archive');
  const providers = {
    async download() {
      return {
        provider: 'modrinth', projectId: 'pack-project', versionId: 'pack-version', versionNumber: '2.0.0', releaseChannel: 'release',
        gameVersions: ['1.21.8'], loaders: ['fabric'], dependencies: [],
        file: { filename: 'pack.mrpack', size: artifact.length, url: 'https://cdn.modrinth.com/data/pack/version/pack.mrpack', hashes: { sha256: crypto.createHash('sha256').update(artifact).digest('hex') } }
      };
    }
  };
  modrinth.installPack = async (packPath, root, options) => {
    assert.equal(await fs.readFile(packPath, 'utf8'), artifact.toString());
    assert.equal(typeof options.download, 'function');
    assert.equal(root, path.join(dataDir, 'servers', server.id));
    return { installedFiles: 12, overrideFiles: 2 };
  };
  const service = new ServerService({ dataDir, runtime, store, modrinth, providers, fetchImpl: async () => new Response(artifact, { status: 200, headers: { 'content-length': String(artifact.length) } }) });
  const server = await service.create({ name: 'Modpack', software: 'FABRIC', version: '1.21.8', port: 25573 });
  const result = await service.installProviderContent(server.id, { provider: 'modrinth', projectId: 'pack-project', versionId: 'pack-version', replace: true });
  assert.equal(result.installedFiles, 12);
  assert.equal(result.stopped, true);
  assert.equal((await service.get(server.id)).status, 'exited');
});

test('creates and controls a server', async () => {
  const { dataDir, runtime, store } = await fixture();
  const service = new ServerService({ dataDir, runtime, store });
  const server = await service.create({ name: 'Survival', software: 'PAPER', port: 25570 });
  assert.equal(server.status, 'running');
  assert.equal('rconPassword' in server, false);
  await service.action(server.id, 'stop');
  assert.equal((await service.get(server.id)).status, 'exited');
  await service.action(server.id, 'rebuild');
  assert.equal((await service.get(server.id)).status, 'running');
  await service.command(server.id, 'say hello');
  assert.equal(runtime.commands[0].command, 'say hello');
  await service.delete(server.id);
  await assert.rejects(() => service.get(server.id), { status: 404 });
});

test('returns recent or complete server logs on demand', async () => {
  const { dataDir, runtime, store } = await fixture();
  const service = new ServerService({ dataDir, runtime, store });
  const server = await service.create({ name: 'Logs', port: 25569 });
  assert.equal(await service.logs(server.id, 'all'), 'ready');
  assert.equal(runtime.logRequests.at(-1).tail, 'all');
  await service.logs(server.id, '999999');
  assert.equal(runtime.logRequests.at(-1).tail, 2000);
  await service.logs(server.id, 'all', 'start', '2026-07-18T12:05:00.000Z');
  assert.deepEqual(runtime.logRequests.at(-1).range, { since: '2026-07-18T12:00:00.000Z', until: '2026-07-18T12:05:00.000Z' });
  await assert.rejects(() => service.logs(server.id, 'all', '2026-07-18T12:05:00.000Z', '2026-07-18T12:00:00.000Z'), { status: 400 });
});

test('does not assign a port twice and tracks backups', async () => {
  const { dataDir, runtime, store } = await fixture();
  const service = new ServerService({ dataDir, runtime, store });
  const server = await service.create({ name: 'Survival', port: 25571 });
  await assert.rejects(() => service.create({ name: 'Creative', port: 25571 }), { status: 400 });
  const backup = await service.backup(server.id);
  const backups = await service.backups(server.id);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].name, backup.name);
  assert.equal(backups[0].size, Buffer.byteLength(server.id));
  await service.restore(server.id, backup.name);
  assert.equal(runtime.restores.length, 1);
});

test('imports, downloads, and deletes portable backup archives', async () => {
  const { dataDir, runtime, store } = await fixture();
  runtime.validateBackup = async () => ({ entries: 1 });
  const service = new ServerService({ dataDir, runtime, store });
  const server = await service.create({ name: 'Imported save', port: 25574 });
  const imported = await service.importBackup(server.id, Readable.from(Buffer.from('portable save')), 13);
  assert.match(imported.name, /^import-.+\.tar\.gz$/);
  const downloaded = await service.downloadBackup(server.id, imported.name);
  assert.equal(downloaded.size, 13);
  await service.deleteBackup(server.id, imported.name);
  await assert.rejects(() => service.downloadBackup(server.id, imported.name), { status: 404 });
});

test('confines file operations to a server data directory', async () => {
  const { dataDir, runtime, store } = await fixture();
  const service = new ServerService({ dataDir, runtime, store });
  const server = await service.create({ name: 'Files', port: 25572 });
  await service.writeFile(server.id, 'server.properties', 'motd=Open MC Host\n');
  const textFile = await service.readFile(server.id, 'server.properties');
  assert.equal(textFile.editable, true);
  assert.match(textFile.content, /Open MC Host/);
  await fs.writeFile(path.join(dataDir, 'servers', server.id, 'binary.dat'), Buffer.from([0, 255, 1, 2]));
  const binaryFile = await service.readFile(server.id, 'binary.dat');
  assert.equal(binaryFile.editable, false);
  assert.equal(binaryFile.content, null);
  assert.equal((await service.files(server.id)).length, 2);
  await assert.rejects(() => service.readFile(server.id, '../access.json'), { status: 403 });
  assert.equal((await service.metrics(server.id)).CPUPerc, '1.2%');
});

test('serializes automatic port allocation under concurrent creates', async () => {
  const { dataDir, runtime, store } = await fixture();
  const service = new ServerService({ dataDir, runtime, store, portRange: '25565-25566' });
  const [first, second] = await Promise.all([
    service.create({ name: 'First world' }),
    service.create({ name: 'Second world' })
  ]);
  assert.deepEqual(new Set([first.port, second.port]), new Set([25565, 25566]));
  await assert.rejects(() => service.create({ name: 'Third world' }), { status: 409 });
});

test('pins the resolved runtime version and Paper build', async () => {
  const { dataDir, runtime, store } = await fixture();
  const versions = {
    async resolve(input) {
      assert.deepEqual(input, { software: 'PAPER', minecraftVersion: '1.21.8', build: '42' });
      return { runtimeVersion: '1.21.8', runtimeBuild: '42' };
    }
  };
  const service = new ServerService({ dataDir, runtime, store, versions });
  const server = await service.create({ name: 'Exact Paper', software: 'PAPER', version: '1.21.8', build: '42' });
  assert.equal(server.version, '1.21.8');
  assert.equal(server.build, '42');
});

test('warns before file replacement and supports streamed uploads', async () => {
  const { dataDir, runtime, store } = await fixture();
  const service = new ServerService({ dataDir, runtime, store, maxUploadBytes: 64 });
  const server = await service.create({ name: 'Uploads' });
  await service.uploadFile(server.id, 'plugins/example.jar', Readable.from(['first']), 5);
  await assert.rejects(() => service.uploadFile(server.id, 'plugins/example.jar', Readable.from(['second']), 6), { status: 409 });
  await service.uploadFile(server.id, 'plugins/example.jar', Readable.from(['second']), 6, null, true);
  assert.equal((await fs.readFile(path.join(dataDir, 'servers', server.id, 'plugins', 'example.jar'), 'utf8')), 'second');
  await assert.rejects(() => service.uploadFile(server.id, 'large.bin', Readable.from(['x'.repeat(65)]), 65), { status: 413 });
});

test('installs exact provider artifacts only after checksum verification', async () => {
  const { dataDir, runtime, store } = await fixture();
  const artifact = Buffer.from('verified plugin bytes');
  const providers = {
    async download(provider, options) {
      assert.equal(provider, 'modrinth');
      assert.equal(options.versionId, 'version-1');
      return {
        provider: 'modrinth', projectId: 'project-1', versionId: 'version-1', versionNumber: '1.0.0', releaseChannel: 'release',
        gameVersions: [], loaders: ['paper'], dependencies: [],
        file: { filename: 'verified.jar', size: artifact.length, url: 'https://cdn.modrinth.com/data/project/version/verified.jar', hashes: { sha256: crypto.createHash('sha256').update(artifact).digest('hex') } }
      };
    }
  };
  const service = new ServerService({ dataDir, runtime, store, providers, fetchImpl: async () => new Response(artifact, { status: 200, headers: { 'content-length': String(artifact.length) } }) });
  const server = await service.create({ name: 'Verified content', software: 'PAPER', version: '1.21.8' });
  const installed = await service.installProviderContent(server.id, { provider: 'modrinth', projectId: 'project-1', versionId: 'version-1' });
  assert.equal(installed.path, 'plugins/verified.jar');
  assert.equal(installed.checksumVerified.algorithm, 'sha256');
  await assert.rejects(() => service.installProviderContent(server.id, { provider: 'modrinth', projectId: 'project-1', versionId: 'version-1' }), { status: 409 });
  await service.installProviderContent(server.id, { provider: 'modrinth', projectId: 'project-1', versionId: 'version-1', replace: true });
});

test('rejects missing or mismatched provider checksums without leaving partial files', async () => {
  const { dataDir, runtime, store } = await fixture();
  const artifact = Buffer.from('untrusted bytes');
  let hashes = {};
  const providers = {
    async download() {
      return {
        provider: 'hangar', projectId: 'project-1', versionId: 'version-1', versionNumber: '1.0.0', releaseChannel: 'release',
        gameVersions: ['1.21.8'], loaders: ['paper'], dependencies: [],
        file: { filename: 'unsafe.jar', size: artifact.length, url: 'https://hangarcdn.papermc.io/plugins/project/versions/version/PAPER/unsafe.jar', hashes }
      };
    }
  };
  const service = new ServerService({ dataDir, runtime, store, providers, fetchImpl: async () => new Response(artifact, { status: 200 }) });
  const server = await service.create({ name: 'Checksum rejection', software: 'PAPER', version: '1.21.8' });
  await assert.rejects(() => service.installProviderContent(server.id, { provider: 'hangar', projectId: 'project-1', versionId: 'version-1' }), { status: 502 });
  hashes = { sha256: '0'.repeat(64) };
  await assert.rejects(() => service.installProviderContent(server.id, { provider: 'hangar', projectId: 'project-1', versionId: 'version-1' }), { status: 502 });
  const pluginDirectory = path.join(dataDir, 'servers', server.id, 'plugins');
  assert.deepEqual(await fs.readdir(pluginDirectory), []);
});

test('lists, disables, enables, and removes installed server content safely', async () => {
  const { dataDir, runtime, store } = await fixture();
  const service = new ServerService({ dataDir, runtime, store });
  const server = await service.create({ name: 'Content manager', software: 'PAPER', version: '1.21.8' });
  await service.writeFile(server.id, 'plugins/example.jar', 'plugin');
  assert.deepEqual((await service.installedContent(server.id)).map((item) => ({ path: item.path, enabled: item.enabled, kind: item.kind })), [{ path: 'plugins/example.jar', enabled: true, kind: 'plugin' }]);
  const disabled = await service.setContentEnabled(server.id, 'plugins/example.jar', false);
  assert.equal(disabled.path, 'plugins/example.jar.disabled');
  assert.equal((await service.installedContent(server.id))[0].enabled, false);
  const enabled = await service.setContentEnabled(server.id, 'plugins/example.jar.disabled', true);
  assert.equal(enabled.path, 'plugins/example.jar');
  await service.removeContent(server.id, 'plugins/example.jar');
  assert.deepEqual(await service.installedContent(server.id), []);
  await assert.rejects(() => service.removeContent(server.id, 'server.properties'), { status: 403 });
  await assert.rejects(() => service.removeContent(server.id, 'plugins/../world/escape.jar'), { status: 403 });
});

test('rolls back a failed exact modpack installation', async () => {
  const { dataDir, runtime, store, modrinth } = await fixture();
  const artifact = Buffer.from('verified modpack archive');
  const providers = {
    async download() {
      return {
        provider: 'modrinth', projectId: 'pack-project', versionId: 'pack-version', versionNumber: '2.0.0', releaseChannel: 'release',
        gameVersions: ['1.21.8'], loaders: ['fabric'], dependencies: [],
        file: { filename: 'pack.mrpack', size: artifact.length, url: 'https://cdn.modrinth.com/data/pack/version/pack.mrpack', hashes: { sha256: crypto.createHash('sha256').update(artifact).digest('hex') } }
      };
    }
  };
  modrinth.installPack = async (packPath, root) => {
    await fs.writeFile(path.join(root, 'partial.txt'), 'partial');
    throw new Error('simulated extraction failure');
  };
  const service = new ServerService({ dataDir, runtime, store, modrinth, providers, fetchImpl: async () => new Response(artifact, { status: 200 }) });
  const server = await service.create({ name: 'Rollback pack', software: 'FABRIC', version: '1.21.8' });
  await fs.mkdir(path.join(dataDir, 'servers', server.id), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'servers', server.id, 'existing.txt'), 'keep');
  await assert.rejects(() => service.installProviderContent(server.id, { provider: 'modrinth', projectId: 'pack-project', versionId: 'pack-version', replace: true }), /simulated extraction failure/);
  assert.equal(runtime.restores.length, 1);
  await assert.rejects(() => fs.access(path.join(dataDir, 'servers', server.id, 'partial.txt')));
});
