const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const { ServerStore } = require('./store');
const { DockerRuntime } = require('./runtime');
const { ServerService } = require('./service');
const { createHandler } = require('./http');
const { SettingsStore } = require('./settings');
const { NetworkService } = require('./network');
const { AccessService } = require('./access');
const { VersionCatalog } = require('./versions');
const { ProviderCatalog } = require('./providers');
const { BackupScheduler } = require('./backup-scheduler');

async function main() {
  const store = new ServerStore(config.dataDir);
  await store.initialize();
  const access = new AccessService({ dataDir: config.dataDir, ownerToken: config.apiToken });
  const accessBootstrap = await access.initialize();
  await migrateServerAccess(store, access, accessBootstrap.principal);
  const settings = new SettingsStore(config);
  await settings.initialize();
  const runtime = new DockerRuntime(config);
  const network = new NetworkService({ runtime, lanIp: config.lanIp, mode: config.networkMode });
  const versions = new VersionCatalog();
  const providers = new ProviderCatalog();
  const service = new ServerService({ store, runtime, settings, network, versions, providers, access, dataDir: config.dataDir, portRange: config.portRange, maxUploadBytes: config.maxUploadBytes });
  const backupScheduler = new BackupScheduler({ service, store, dataDir: config.dataDir, enabled: config.autoBackupEnabled, hour: config.autoBackupHour });
  await backupScheduler.initialize();
  backupScheduler.start();
  const sshGatewayToken = await ensureSecret(path.join(config.dataDir, 'ssh-gateway-token'));
  const server = http.createServer(createHandler({ service, runtime, settings, access, sshGatewayToken, publicDir: path.join(__dirname, '..', 'public'), assetsDir: path.join(__dirname, '..', 'assets') }));
  if (accessBootstrap.credential) console.log(`Open MC Host owner access key: ${accessBootstrap.credential}`);
  server.listen(config.port, config.host, () => console.log(`Open MC Host listening at http://${config.host}:${config.port}`));
}

async function migrateServerAccess(store, access, owner) {
  const registered = new Map((await access.listAccessibleServers(owner)).map((item) => [item.serverId, item]));
  for (const server of await store.list()) {
    let accessRecord = registered.get(server.id);
    if (!accessRecord) {
      accessRecord = await access.registerServer(owner.id, { serverId: server.id, ownerId: owner.id, memoryMiB: memoryMiB(server.memory), storageBytes: 0 });
      registered.set(server.id, accessRecord);
    }
    const ownerId = accessRecord.ownerId;
    const createdById = !server.createdById || server.createdById === 'owner' ? ownerId : server.createdById;
    if (server.ownerId !== ownerId || server.createdById !== createdById) await store.update(server.id, { ownerId, createdById });
  }
}

function memoryMiB(value) {
  const match = String(value || '2G').match(/^(\d+)(M|G)$/i);
  return match ? Number(match[1]) * (match[2].toUpperCase() === 'G' ? 1024 : 1) : 2048;
}

async function ensureSecret(file) {
  try {
    const secret = (await fs.readFile(file, 'utf8')).trim();
    if (secret.length >= 32) return secret;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  await fs.writeFile(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { main, migrateServerAccess, memoryMiB };
