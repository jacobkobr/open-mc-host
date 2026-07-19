const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('./errors');
const { serverSoftware } = require('./catalog');
const { ModrinthClient } = require('./modrinth');

const SOFTWARE = new Set(['VANILLA', 'PAPER', 'PURPUR', 'FABRIC', 'FORGE', 'NEOFORGE']);

function validate(input) {
  const name = String(input.name || '').trim();
  const software = String(input.software || 'PAPER').toUpperCase();
  const version = String(input.version || 'LATEST').trim();
  const build = String(input.build || '').trim();
  const memory = String(input.memory || '2G').toUpperCase();
  const cpus = Number(input.cpus || 1);
  const port = input.port === '' || input.port === undefined || input.port === null ? null : Number(input.port);
  if (!/^[a-zA-Z0-9 _.-]{3,48}$/.test(name)) throw new AppError('Name must be 3-48 letters, numbers, spaces, dots, underscores, or dashes.');
  if (!SOFTWARE.has(software)) throw new AppError(`Software must be one of: ${[...SOFTWARE].join(', ')}.`);
  if (!/^[a-zA-Z0-9._-]{1,32}$/.test(version)) throw new AppError('Version is invalid.');
  if (build && !/^[a-zA-Z0-9._+-]{1,64}$/.test(build)) throw new AppError('Server build is invalid.');
  if (!/^\d+(M|G)$/.test(memory)) throw new AppError('Memory must use M or G, such as 2G.');
  if (!Number.isFinite(cpus) || cpus < 0.25 || cpus > 16) throw new AppError('CPU limit must be between 0.25 and 16.');
  if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new AppError('Port must be between 1024 and 65535.');
  return { name, software, version, build, memory, cpus, port };
}

class ServerService {
  constructor({ store, runtime, dataDir, settings = { get: async () => ({ publicHost: '' }) }, network, modrinth = new ModrinthClient(), portRange = '25565-25575', maxUploadBytes = 250 * 1024 * 1024, versions = null, providers = null, access = null, fetchImpl = globalThis.fetch }) {
    this.store = store;
    this.runtime = runtime;
    this.backupDir = path.join(dataDir, 'backups');
    this.modrinth = modrinth;
    this.settings = settings;
    this.network = network;
    this.portRange = parsePortRange(portRange);
    this.maxUploadBytes = maxUploadBytes;
    this.versions = versions;
    this.providers = providers;
    this.access = access;
    this.fetchImpl = fetchImpl;
    this.creationQueue = Promise.resolve();
  }

  async list(principal = null) {
    let servers = await this.store.list();
    if (this.access) {
      if (!principal) throw new AppError('Authentication is required.', 401);
      if (principal.role !== 'owner') {
        const accessible = new Map((await this.access.listAccessibleServers(principal)).map((item) => [item.serverId, item.access]));
        servers = servers.filter((server) => accessible.has(server.id)).map((server) => ({ ...server, access: accessible.get(server.id) }));
      } else servers = servers.map((server) => ({ ...server, access: 'manage' }));
    }
    const { publicHost } = await this.settings.get();
    return Promise.all(servers.map(async (server) => this.present(server, await this.runtime.status(server), publicHost)));
  }

  async get(id, principal = null) {
    await this.assertAccess(principal, 'server.read', id);
    let server = await this.store.get(id);
    if (this.access) {
      const access = principal.role === 'owner' ? 'manage' : (await this.access.listAccessibleServers(principal)).find((item) => item.serverId === id)?.access;
      server = { ...server, access };
    }
    const { publicHost } = await this.settings.get();
    return this.present(server, await this.runtime.status(server), publicHost);
  }

  present(server, status, publicHost) {
    const { rconPassword, ...publicServer } = server;
    return { ...publicServer, status, connectionAddress: publicHost ? `${publicHost}:${server.port}` : null };
  }

  create(input, principal = null) {
    const operation = this.creationQueue.then(() => this.createServer(input, principal));
    this.creationQueue = operation.catch(() => {});
    return operation;
  }

  async createServer(input, principal = null) {
    const values = validate(input);
    const existing = await this.store.list();
    values.port = values.port || allocatePort(existing, this.portRange);
    if (existing.some((server) => server.port === values.port)) throw new AppError('That host port is already assigned.');
    await this.assertAccess(principal, 'server.create');
    if (this.versions) {
      if (values.version === 'LATEST') {
        const available = await this.versions.minecraftVersions({ software: values.software });
        if (!available.length) throw new AppError('No stable Minecraft releases are available.', 502);
        values.version = available[0].id;
      }
      const resolved = await this.versions.resolve({ software: values.software, minecraftVersion: values.version, build: values.build });
      values.version = resolved.runtimeVersion;
      values.build = resolved.runtimeBuild || '';
    }
    const server = await this.store.create({ ...values, ownerId: principal?.id || 'owner', createdById: principal?.id || 'owner', rconPassword: crypto.randomBytes(24).toString('base64url') });
    let registered = false;
    try {
      if (this.access) {
        await this.access.registerServer(principal.id, { serverId: server.id, ownerId: principal.id, memoryMiB: memoryMiB(server.memory), storageBytes: 0 });
        registered = true;
      }
      await this.runtime.create(server);
      await this.audit(principal, 'server.created', { serverId: server.id, port: server.port, software: server.software, version: server.version });
      return this.get(server.id, principal);
    } catch (error) {
      if (registered) await this.access.unregisterServer(principal.id, server.id).catch(() => {});
      await this.store.remove(server.id);
      throw error;
    }
  }

  async action(id, action, principal = null) {
    const server = await this.store.get(id);
    if (!['start', 'stop', 'restart', 'rebuild'].includes(action)) throw new AppError('Unsupported server action.');
    await this.assertAccess(principal, action === 'rebuild' ? 'server.files' : 'server.control', id);
    if (action === 'rebuild') {
      await this.runtime.remove(server);
      await this.runtime.create(server);
      await this.audit(principal, 'server.runtime_rebuilt', { serverId: id });
      return this.get(id, principal);
    }
    await this.runtime[action](server);
    await this.audit(principal, `server.${action}`, { serverId: id });
    return this.get(id, principal);
  }

  async delete(id, principal = null) {
    await this.assertAccess(principal, 'server.delete', id);
    const server = await this.store.get(id);
    await this.runtime.remove(server);
    await this.store.remove(id);
    if (this.access) await this.access.unregisterServer(principal.id, id);
    await this.audit(principal, 'server.deleted', { serverId: id, name: server.name });
  }

  async logs(id, tail, since = null, until = null, principal = null) {
    await this.assertAccess(principal, 'server.logs', id);
    const server = await this.store.get(id);
    const requestedTail = String(tail || '').toLowerCase() === 'all' ? 'all' : Math.min(Math.max(Number(tail) || 200, 1), 2000);
    const requestedSince = String(since || '').trim().toLowerCase();
    const serverStartedAt = requestedSince === 'start' && typeof this.runtime.startedAt === 'function' ? await this.runtime.startedAt(server) : null;
    if (requestedSince === 'start' && !serverStartedAt) throw new AppError('The server start time is unavailable. Start the server and try again.', 503);
    const resolvedSince = requestedSince === 'start' ? normalizeLogTimestamp(serverStartedAt, 'Server start time') : normalizeLogTimestamp(since, 'Start time');
    const resolvedUntil = normalizeLogTimestamp(until, 'End time');
    if (resolvedSince && resolvedUntil && Date.parse(resolvedSince) > Date.parse(resolvedUntil)) throw new AppError('Start time must be before end time.');
    return this.runtime.logs(server, requestedTail, { since: resolvedSince, until: resolvedUntil });
  }
  async command(id, command, principal = null) { await this.assertAccess(principal, 'server.command', id); const result = await this.runtime.command(await this.store.get(id), command); await this.audit(principal, 'server.command', { serverId: id }); return result; }
  async metrics(id, principal = null) { await this.assertAccess(principal, 'server.metrics', id); return this.runtime.metrics(await this.store.get(id)); }
  async connectivity(id, principal = null) {
    await this.assertAccess(principal, 'server.read', id);
    if (!this.network) throw new AppError('Network diagnostics are unavailable.', 503);
    const { publicHost } = await this.settings.get();
    return this.network.check(await this.store.get(id), { publicHost });
  }

  async files(id, requestedPath = '.', principal = null) {
    await this.assertAccess(principal, 'server.files', id);
    const filePath = await this.resolveFile(id, requestedPath);
    const entries = await fs.readdir(filePath, { withFileTypes: true });
    return Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(filePath, entry.name);
      const stats = await fs.lstat(fullPath);
      return { name: entry.name, path: path.relative(await this.serverDirectory(id), fullPath).replaceAll('\\', '/'), type: stats.isSymbolicLink() ? 'blocked' : entry.isDirectory() ? 'directory' : 'file', size: stats.isSymbolicLink() ? 0 : stats.size, modifiedAt: stats.mtime.toISOString() };
    }));
  }

  async readFile(id, requestedPath, principal = null) {
    await this.assertAccess(principal, 'server.files', id);
    const filePath = await this.resolveFile(id, requestedPath);
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new AppError('Path must reference a file.');
    if (stats.size > 1_000_000) throw new AppError('Files over 1 MB cannot be edited through the API.', 413);
    const contents = await fs.readFile(filePath);
    const text = decodeEditableText(contents);
    return { path: requestedPath, size: stats.size, editable: text !== null, content: text };
  }

  async writeFile(id, requestedPath, content, principal = null) {
    await this.assertAccess(principal, 'server.files', id);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1_000_000) throw new AppError('File content must be text up to 1 MB.', 413);
    const filePath = await this.resolveFile(id, requestedPath, { allowMissing: true });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await this.reserveFileStorage(id, principal, filePath, Buffer.byteLength(content));
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, filePath);
    } catch (error) {
      await this.syncStorageUsage(id, principal).catch(() => {});
      throw error;
    } finally {
      await fs.rm(temporary, { force: true });
    }
    await this.audit(principal, 'server.file_written', { serverId: id, path: requestedPath });
    return { path: requestedPath, size: Buffer.byteLength(content) };
  }

  async uploadFile(id, requestedPath, readable, contentLength = 0, principal = null, replace = false) {
    await this.assertAccess(principal, 'server.files', id);
    if (Number(contentLength) > this.maxUploadBytes) throw new AppError(`Uploads are limited to ${Math.floor(this.maxUploadBytes / 1024 / 1024)} MB.`, 413);
    const filePath = await this.resolveFile(id, requestedPath, { allowMissing: true });
    if (path.basename(filePath).startsWith('.open-mc-host-')) throw new AppError('That file name is reserved.');
    try {
      const existing = await fs.lstat(filePath);
      if (existing.isSymbolicLink()) throw new AppError('Symbolic links cannot be replaced.', 403);
      if (existing.isDirectory()) throw new AppError('A directory already uses that name.', 409);
      if (!replace) throw new AppError('A file with that name already exists. Confirm replacement to continue.', 409);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${crypto.randomUUID()}.open-mc-host-upload`;
    let received = 0;
    const limiter = new Transform({
      transform: (chunk, encoding, callback) => {
        received += chunk.length;
        if (received > this.maxUploadBytes) return callback(new AppError(`Uploads are limited to ${Math.floor(this.maxUploadBytes / 1024 / 1024)} MB.`, 413));
        callback(null, chunk);
      }
    });
    try {
      await pipeline(readable, limiter, fsSync.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (this.access) {
        const existingSize = await fileSize(filePath);
        const currentSize = await directorySize(await this.serverDirectory(id));
        await this.access.updateServerStorage(principal.id, id, currentSize - existingSize);
      }
      await fs.rename(temporary, filePath);
      const result = { path: path.relative(await this.serverDirectory(id), filePath).replaceAll('\\', '/'), size: received, restartRecommended: /\.(jar|zip|mrpack)$/i.test(filePath) };
      await this.audit(principal, 'server.file_uploaded', { serverId: id, path: result.path, size: received });
      return result;
    } catch (error) {
      await fs.rm(temporary, { force: true });
      await this.syncStorageUsage(id, principal).catch(() => {});
      throw error;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async downloadFile(id, requestedPath, principal = null) {
    await this.assertAccess(principal, 'server.files', id);
    const filePath = await this.resolveFile(id, requestedPath);
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new AppError('Path must reference a file.');
    return { filePath, name: path.basename(filePath), size: stats.size };
  }

  async createDirectory(id, requestedPath, principal = null) {
    await this.assertAccess(principal, 'server.files', id);
    const directory = await this.resolveFile(id, requestedPath, { allowMissing: true });
    await fs.mkdir(directory, { recursive: false });
    await this.audit(principal, 'server.directory_created', { serverId: id, path: requestedPath });
    return { path: requestedPath };
  }

  async renameFile(id, requestedPath, destinationPath, principal = null, replace = false) {
    await this.assertAccess(principal, 'server.files', id);
    const root = await this.serverDirectory(id);
    const source = await this.resolveFile(id, requestedPath);
    const destination = await this.resolveFile(id, destinationPath, { allowMissing: true });
    if (source === root || destination === root) throw new AppError('The server data root cannot be renamed.');
    let displaced = null;
    try {
      const existing = await fs.lstat(destination);
      if (existing.isDirectory() || existing.isSymbolicLink()) throw new AppError('Directories and symbolic links cannot be replaced.', 409);
      if (!replace) throw new AppError('The destination already exists. Confirm replacement to continue.', 409);
      displaced = `${destination}.${crypto.randomUUID()}.open-mc-host-replaced`;
      await fs.rename(destination, displaced);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.rename(source, destination);
    } catch (error) {
      if (displaced) await fs.rename(displaced, destination).catch(() => {});
      throw error;
    }
    if (displaced) await fs.rm(displaced, { force: true });
    await this.audit(principal, 'server.file_renamed', { serverId: id, path: requestedPath, destination: destinationPath });
    return { path: destinationPath };
  }

  async deleteFile(id, requestedPath, principal = null) {
    await this.assertAccess(principal, 'server.files', id);
    const root = await this.serverDirectory(id);
    const target = await this.resolveFile(id, requestedPath);
    if (target === root) throw new AppError('The server data root cannot be deleted.');
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink()) throw new AppError('Symbolic links cannot be managed through the dashboard.', 403);
    await fs.rm(target, { recursive: stats.isDirectory(), force: false });
    await this.syncStorageUsage(id, principal);
    await this.audit(principal, 'server.file_deleted', { serverId: id, path: requestedPath });
    return { path: requestedPath };
  }

  async resolveFile(id, requestedPath, { allowMissing = false } = {}) {
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) throw new AppError('A file path is required.');
    const root = await this.serverDirectory(id);
    const target = path.resolve(root, requestedPath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new AppError('File path must stay inside the server data directory.', 403);
    const parts = path.relative(root, target).split(path.sep).filter(Boolean);
    let cursor = root;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      try {
        const stats = await fs.lstat(cursor);
        if (stats.isSymbolicLink()) throw new AppError('Symbolic links cannot be managed through the dashboard.', 403);
      } catch (error) {
        if (error.code === 'ENOENT' && allowMissing) break;
        throw error;
      }
    }
    return target;
  }

  async serverDirectory(id) {
    const server = await this.store.get(id);
    const directory = this.runtime.serverDir(server);
    await fs.mkdir(directory, { recursive: true });
    const stats = await fs.lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new AppError('Server storage is not a safe directory.', 403);
    return directory;
  }

  async assertAccess(principal, action, serverId = null) {
    if (!this.access) return;
    if (!principal) throw new AppError('Authentication is required.', 401);
    await this.access.assertAuthorized(principal, action, serverId);
  }

  async audit(principal, action, details = {}) {
    if (this.access && principal && typeof this.access.recordEvent === 'function') await this.access.recordEvent(principal.id, action, details);
  }

  async systemAudit(action, details = {}) {
    if (this.access && typeof this.access.recordSystemEvent === 'function') await this.access.recordSystemEvent(action, details);
  }

  async reserveFileStorage(id, principal, destination, replacementSize) {
    if (!this.access) return;
    const root = await this.serverDirectory(id);
    const currentSize = await directorySize(root);
    const previousSize = await fileSize(destination);
    await this.access.updateServerStorage(principal.id, id, currentSize - previousSize + Number(replacementSize || 0));
  }

  async syncStorageUsage(id, principal) {
    if (!this.access) return null;
    const size = await directorySize(await this.serverDirectory(id));
    return this.access.updateServerStorage(principal.id, id, size);
  }

  catalog() {
    return {
      software: serverSoftware,
      providers: [
        { id: 'modrinth', name: 'Modrinth', kinds: ['plugin', 'mod', 'modpack'] },
        { id: 'hangar', name: 'Hangar', kinds: ['plugin'] }
      ]
    };
  }

  async minecraftVersions(software) {
    if (!this.versions) throw new AppError('Version discovery is unavailable.', 503);
    return this.versions.minecraftVersions({ software });
  }

  async serverBuilds(software, minecraftVersion) {
    if (!this.versions) throw new AppError('Build discovery is unavailable.', 503);
    return this.versions.serverBuilds({ software, minecraftVersion });
  }

  async searchProvider(provider, options) {
    if (!this.providers) throw new AppError('Content providers are unavailable.', 503);
    return this.providers.search(provider, options);
  }

  async providerVersions(provider, options) {
    if (!this.providers) throw new AppError('Content providers are unavailable.', 503);
    return this.providers.versions(provider, options);
  }

  async installProviderContent(id, input, principal = null) {
    await this.assertAccess(principal, 'server.files', id);
    if (!this.providers) throw new AppError('Content providers are unavailable.', 503);
    const server = await this.store.get(id);
    const provider = String(input.provider || '').toLowerCase();
    const projectId = String(input.projectId || '');
    const versionId = String(input.versionId || '');
    const target = this.modrinthTarget(server);
    const release = await this.providers.download(provider, {
      projectId,
      versionId,
      filename: input.filename,
      loader: target.loader,
      platform: target.loader
    });
    this.assertReleaseCompatible(server, release, target.loader);

    if (/\.mrpack$/i.test(release.file.filename)) {
      if (provider !== 'modrinth') throw new AppError('Only Modrinth modpacks can be installed automatically.', 422);
      if (input.replace !== true) throw new AppError('Installing a modpack can replace world and configuration files. Confirm replacement to continue.', 409);
      const root = await this.serverDirectory(id);
      const temporary = path.join(root, `.open-mc-host-${crypto.randomUUID()}.mrpack`);
      const rollback = path.join(this.backupDir, id, `.rollback-${crypto.randomUUID()}.tar.gz`);
      const status = await this.runtime.status(server);
      if (status === 'running') await this.runtime.stop(server);
      try {
        await this.runtime.backup(server, rollback);
        await this.downloadVerified(release.file, temporary, { replace: true });
        const result = await this.modrinth.installPack(temporary, root, {
          download: (file, destination) => this.downloadVerified(file, destination, { replace: true })
        });
        await this.syncStorageUsage(id, principal);
        await this.audit(principal, 'server.modpack_installed', { serverId: id, provider, projectId, versionId: release.versionId });
        return { ...release, ...result, path: '.', restartRequired: true, stopped: status === 'running' };
      } catch (error) {
        try {
          await fs.rm(root, { recursive: true, force: true });
          await fs.mkdir(root, { recursive: true });
          await this.runtime.restore(server, rollback);
          await this.syncStorageUsage(id, principal).catch(() => {});
        } catch (rollbackError) {
          throw new AppError(`Modpack installation failed and rollback also failed: ${rollbackError.message}`, 500);
        }
        throw error;
      } finally {
        await fs.rm(temporary, { force: true });
        await fs.rm(rollback, { force: true });
      }
    }

    if (!/\.(jar|zip)$/i.test(release.file.filename)) throw new AppError('The selected release is not a supported server artifact.', 422);
    const root = await this.serverDirectory(id);
    const destination = path.join(root, target.directory, release.file.filename);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await this.reserveFileStorage(id, principal, destination, release.file.size);
    let installed;
    try {
      installed = await this.downloadVerified(release.file, destination, { replace: input.replace === true });
    } catch (error) {
      await this.syncStorageUsage(id, principal).catch(() => {});
      throw error;
    }
    const dependencies = input.installDependencies === false
      ? []
      : await this.installRequiredDependencies({ server, release, target, root, replace: input.replace === true, principal });
    await this.syncStorageUsage(id, principal);
    await this.audit(principal, 'server.content_installed', { serverId: id, provider, projectId, versionId: release.versionId, path: path.relative(root, destination).replaceAll('\\', '/') });
    return {
      ...release,
      file: { ...release.file, url: undefined },
      path: path.relative(root, destination).replaceAll('\\', '/'),
      checksumVerified: installed.checksumVerified,
      installedDependencies: dependencies,
      restartRequired: true
    };
  }

  async installedContent(id, principal = null) {
    await this.assertAccess(principal, 'server.read', id);
    const server = await this.store.get(id);
    if (server.software === 'VANILLA') return [];
    const target = this.modrinthTarget(server);
    const root = await this.serverDirectory(id);
    const directory = path.join(root, target.directory);
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const content = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(jar|zip)(\.disabled)?$/i.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      const stats = await fs.lstat(filePath);
      if (stats.isSymbolicLink()) continue;
      content.push({
        name: entry.name.replace(/\.disabled$/i, ''),
        path: path.relative(root, filePath).replaceAll('\\', '/'),
        kind: target.directory === 'plugins' ? 'plugin' : 'mod',
        enabled: !entry.name.endsWith('.disabled'),
        size: stats.size,
        modifiedAt: stats.mtime.toISOString()
      });
    }
    return content.sort((left, right) => left.name.localeCompare(right.name));
  }

  async setContentEnabled(id, requestedPath, enabled, principal = null) {
    await this.assertAccess(principal, 'server.files', id);
    if (typeof enabled !== 'boolean') throw new AppError('enabled must be true or false.');
    const server = await this.store.get(id);
    const relativePath = this.assertContentPath(server, requestedPath);
    const currentlyDisabled = relativePath.endsWith('.disabled');
    if (enabled === !currentlyDisabled) return { path: relativePath, enabled: !currentlyDisabled, restartRequired: false };
    const destination = enabled ? relativePath.replace(/\.disabled$/i, '') : `${relativePath}.disabled`;
    const result = await this.renameFile(id, relativePath, destination, principal, false);
    await this.audit(principal, enabled ? 'server.content_enabled' : 'server.content_disabled', { serverId: id, path: destination });
    return { ...result, enabled, restartRequired: true };
  }

  async removeContent(id, requestedPath, principal = null) {
    await this.assertAccess(principal, 'server.files', id);
    const server = await this.store.get(id);
    const relativePath = this.assertContentPath(server, requestedPath);
    await this.deleteFile(id, relativePath, principal);
    await this.audit(principal, 'server.content_removed', { serverId: id, path: relativePath });
    return { path: relativePath, restartRequired: true };
  }

  assertContentPath(server, requestedPath) {
    const target = this.modrinthTarget(server);
    const value = String(requestedPath || '').replaceAll('\\', '/').replace(/^\.\//, '');
    const normalized = path.posix.normalize(value);
    if (normalized !== value || !normalized.startsWith(`${target.directory}/`) || !/\.(jar|zip)(\.disabled)?$/i.test(normalized)) throw new AppError('Content path must reference an installed mod or plugin.', 403);
    return normalized;
  }

  assertReleaseCompatible(server, release, loader) {
    if (release.gameVersions.length && !release.gameVersions.includes(server.version)) {
      throw new AppError(`That release does not support Minecraft ${server.version}.`, 409);
    }
    if (release.loaders.length && !release.loaders.map((value) => value.toLowerCase()).includes(loader.toLowerCase())) {
      throw new AppError(`That release does not support ${loader}.`, 409);
    }
  }

  async installRequiredDependencies({ server, release, target, root, replace, principal }) {
    if (release.provider !== 'modrinth') return release.dependencies.filter((item) => item.required).map((item) => ({ ...item, installed: false, reason: 'Manual dependency review required.' }));
    const installed = [];
    const seen = new Set([release.versionId]);
    for (const dependency of release.dependencies.filter((item) => item.required).slice(0, 25)) {
      let versionId = dependency.versionId;
      if (!versionId && dependency.projectId) {
        const versions = await this.providers.versions('modrinth', { projectId: dependency.projectId, gameVersion: server.version, loader: target.loader, limit: 25 });
        versionId = versions.items[0]?.id;
      }
      if (!versionId || seen.has(versionId)) {
        installed.push({ ...dependency, installed: false, reason: versionId ? 'Already processed.' : 'No compatible exact version found.' });
        continue;
      }
      seen.add(versionId);
      const metadata = await this.providers.download('modrinth', { projectId: dependency.projectId || undefined, versionId });
      this.assertReleaseCompatible(server, metadata, target.loader);
      const destination = path.join(root, target.directory, metadata.file.filename);
      try {
        await this.reserveFileStorage(server.id, principal, destination, metadata.file.size);
        const result = await this.downloadVerified(metadata.file, destination, { replace });
        installed.push({ projectId: metadata.projectId, versionId: metadata.versionId, versionNumber: metadata.versionNumber, path: path.relative(root, destination).replaceAll('\\', '/'), installed: true, checksumVerified: result.checksumVerified });
      } catch (error) {
        await this.syncStorageUsage(server.id, principal).catch(() => {});
        if (error.status === 409) installed.push({ projectId: metadata.projectId, versionId: metadata.versionId, path: path.relative(root, destination).replaceAll('\\', '/'), installed: false, reason: 'A file with this name already exists.' });
        else throw error;
      }
    }
    return installed;
  }

  async downloadVerified(file, destination, { replace = false } = {}) {
    if (typeof this.fetchImpl !== 'function') throw new AppError('Artifact downloads are unavailable.', 503);
    try {
      const existing = await fs.lstat(destination);
      if (existing.isSymbolicLink()) throw new AppError('Symbolic links cannot be replaced.', 403);
      if (!replace) throw new AppError('A file with that name already exists. Confirm replacement to continue.', 409);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const hashes = file.hashes || {};
    const algorithm = ['sha512', 'sha256', 'sha1'].find((name) => hashes[name]);
    if (!algorithm) throw new AppError('The provider did not supply a supported checksum.', 502);
    let response;
    try {
      response = await this.fetchImpl(file.url, { redirect: 'error', headers: { 'user-agent': 'OpenMCHost/0.1.0 (self-hosted Minecraft control panel)' } });
    } catch (error) {
      throw new AppError(`Artifact download failed: ${error.message}`, 502);
    }
    if (!response?.ok || !response.body) throw new AppError(`Artifact download failed (${response?.status || 502}).`, 502);
    if (Number(response.headers?.get?.('content-length') || 0) > this.maxUploadBytes) throw new AppError('The provider artifact exceeds the configured download limit.', 413);
    const temporary = `${destination}.${crypto.randomUUID()}.open-mc-host-download`;
    const digest = crypto.createHash(algorithm);
    let received = 0;
    const verifier = new Transform({
      transform: (chunk, encoding, callback) => {
        received += chunk.length;
        if (received > this.maxUploadBytes) return callback(new AppError('The provider artifact exceeds the configured download limit.', 413));
        digest.update(chunk);
        callback(null, chunk);
      }
    });
    try {
      const readable = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
      await pipeline(readable, verifier, fsSync.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      const actual = digest.digest('hex');
      if (actual !== hashes[algorithm]) throw new AppError(`${algorithm.toUpperCase()} checksum verification failed.`, 502);
      await fs.rename(temporary, destination);
      return { size: received, checksumVerified: { algorithm, value: actual } };
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  modrinthTarget(server) {
    if (server.software === 'PAPER' || server.software === 'PURPUR') return { loader: 'paper', directory: 'plugins' };
    if (server.software === 'FABRIC') return { loader: 'fabric', directory: 'mods' };
    if (server.software === 'FORGE') return { loader: 'forge', directory: 'mods' };
    if (server.software === 'NEOFORGE') return { loader: 'neoforge', directory: 'mods' };
    throw new AppError(`${server.software} does not support Modrinth plugin or mod installation.`);
  }

  async backups(id, principal = null) {
    await this.assertAccess(principal, 'server.backup', id);
    await this.store.get(id);
    const dir = path.join(this.backupDir, id);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return (await Promise.all(entries
        .filter((entry) => entry.isFile() && validBackupName(entry.name))
        .map(async (entry) => {
          const stats = await fs.stat(path.join(dir, entry.name));
          return { name: entry.name, size: stats.size, createdAt: stats.mtime.toISOString() };
        })))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async backup(id, principal = null) {
    await this.assertAccess(principal, 'server.backup', id);
    const server = await this.store.get(id);
    return this.createBackup(server, { principal, action: 'server.backup_created' });
  }

  async automaticBackup(id) {
    const server = await this.store.get(id);
    return this.createBackup(server, { action: 'server.backup_scheduled', automated: true });
  }

  async createBackup(server, { principal = null, action, automated = false }) {
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
    const backupPath = this.backupPath(server.id, name);
    const running = await this.runtime.status(server) === 'running';
    let savesPaused = false;
    try {
      if (running) {
        await this.runtime.command(server, 'save-off');
        savesPaused = true;
        await this.runtime.command(server, 'save-all flush');
      }
      await this.runtime.backup(server, backupPath);
    } finally {
      if (savesPaused) await this.runtime.command(server, 'save-on').catch(() => {});
    }
    const stats = await fs.stat(backupPath);
    if (automated) await this.systemAudit(action, { serverId: server.id, backup: name });
    else await this.audit(principal, action, { serverId: server.id, backup: name });
    return { name, size: stats.size, createdAt: stats.mtime.toISOString(), consistent: true };
  }

  async restore(id, name, principal = null) {
    await this.assertAccess(principal, 'server.backup', id);
    if (!validBackupName(name)) throw new AppError('Invalid backup name.');
    const server = await this.store.get(id);
    const backupPath = this.backupPath(id, name);
    try { await fs.access(backupPath); } catch { throw new AppError('Backup not found.', 404); }
    const status = await this.runtime.status(server);
    if (status === 'running') await this.runtime.stop(server);
    await fs.rm(this.runtime.serverDir(server), { recursive: true, force: true });
    await fs.mkdir(this.runtime.serverDir(server), { recursive: true });
    await this.runtime.restore(server, backupPath);
    await this.audit(principal, 'server.backup_restored', { serverId: id, backup: name });
    return this.get(id, principal);
  }

  backupPath(id, name) {
    if (!validBackupName(name)) throw new AppError('Invalid backup name.');
    return path.join(this.backupDir, id, name);
  }

  async downloadBackup(id, name, principal = null) {
    await this.assertAccess(principal, 'server.backup', id);
    const backupPath = this.backupPath(id, name);
    try {
      const stats = await fs.stat(backupPath);
      if (!stats.isFile()) throw new AppError('Backup not found.', 404);
      return { filePath: backupPath, name, size: stats.size };
    } catch (error) {
      if (error.code === 'ENOENT') throw new AppError('Backup not found.', 404);
      throw error;
    }
  }

  async deleteBackup(id, name, principal = null) {
    await this.assertAccess(principal, 'server.backup', id);
    const backupPath = this.backupPath(id, name);
    try { await fs.rm(backupPath); } catch (error) { if (error.code === 'ENOENT') throw new AppError('Backup not found.', 404); throw error; }
    await this.audit(principal, 'server.backup_deleted', { serverId: id, backup: name });
  }

  async importBackup(id, readable, contentLength = 0, principal = null) {
    await this.assertAccess(principal, 'server.backup', id);
    await this.store.get(id);
    if (Number(contentLength) > this.maxUploadBytes) throw new AppError(`Backup uploads are limited to ${Math.floor(this.maxUploadBytes / 1024 / 1024)} MB.`, 413);
    const name = `import-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.tar.gz`;
    const destination = this.backupPath(id, name);
    const temporary = `${destination}.${crypto.randomUUID()}.upload`;
    let received = 0;
    const limiter = new Transform({
      transform: (chunk, encoding, callback) => {
        received += chunk.length;
        if (received > this.maxUploadBytes) return callback(new AppError(`Backup uploads are limited to ${Math.floor(this.maxUploadBytes / 1024 / 1024)} MB.`, 413));
        callback(null, chunk);
      }
    });
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await pipeline(readable, limiter, fsSync.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (!received) throw new AppError('The backup upload is empty.', 400);
      if (typeof this.runtime.validateBackup === 'function') await this.runtime.validateBackup(temporary);
      await fs.rename(temporary, destination);
      const stats = await fs.stat(destination);
      await this.audit(principal, 'server.backup_imported', { serverId: id, backup: name, size: stats.size });
      return { name, size: stats.size, createdAt: stats.mtime.toISOString(), imported: true };
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

function parsePortRange(value) {
  const match = String(value || '').match(/^(\d{4,5})-(\d{4,5})$/);
  if (!match) throw new AppError('MC_HOST_PORT_RANGE must look like 25565-25575.', 500);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1024 || end > 65535 || start > end) throw new AppError('MC_HOST_PORT_RANGE is invalid.', 500);
  return { start, end };
}

function allocatePort(servers, range) {
  const used = new Set(servers.map((server) => server.port));
  for (let port = range.start; port <= range.end; port += 1) if (!used.has(port)) return port;
  throw new AppError(`No free Minecraft ports remain in ${range.start}-${range.end}.`, 409);
}

function memoryMiB(memory) {
  const match = String(memory || '').match(/^(\d+)(M|G)$/i);
  if (!match) throw new AppError('Memory must use M or G, such as 2G.');
  return Number(match[1]) * (match[2].toUpperCase() === 'G' ? 1024 : 1);
}

function validBackupName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}\.tar\.gz$/.test(String(name || ''));
}

function normalizeLogTimestamp(value, field) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  if (Number.isNaN(timestamp)) throw new AppError(`${field} is invalid.`);
  return new Date(timestamp).toISOString();
}

async function fileSize(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    return stats.isFile() && !stats.isSymbolicLink() ? stats.size : 0;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

function decodeEditableText(contents) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) total += await directorySize(entryPath);
    else if (stats.isFile()) total += stats.size;
  }
  return total;
}

module.exports = { ServerService, validate, SOFTWARE, allocatePort, parsePortRange, memoryMiB, directorySize };
