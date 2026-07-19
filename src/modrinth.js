const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { AppError } = require('./errors');

class ModrinthClient {
  async installPack(packPath, serverDirectory, { download } = {}) {
    if (typeof download !== 'function') throw new AppError('A verified modpack downloader is required.', 503);
    const names = (await command('unzip', ['-Z1', packPath])).split(/\r?\n/).filter(Boolean);
    if (!names.includes('modrinth.index.json')) throw new AppError('The Modrinth archive is missing modrinth.index.json.');
    if (names.some((name) => !safeArchivePath(name))) throw new AppError('The Modrinth archive contains an unsafe path.');
    const rawIndex = await command('unzip', ['-p', packPath, 'modrinth.index.json']);
    let index;
    try { index = JSON.parse(rawIndex); } catch { throw new AppError('The Modrinth archive has an invalid index file.'); }
    if (!Array.isArray(index.files) || index.files.length > 600) throw new AppError('The Modrinth archive has an invalid or oversized file list.');
    const overrideFiles = names.filter((name) => name.startsWith('overrides/'));
    if (overrideFiles.length) await installOverrides(packPath, serverDirectory, overrideFiles);
    let installedFiles = 0;
    for (const item of index.files) {
      if (!safeArchivePath(item.path) || !Array.isArray(item.downloads) || !item.downloads.length) throw new AppError('The Modrinth archive contains an invalid download entry.');
      const downloadUrl = item.downloads.find(isAllowedDownload);
      if (!downloadUrl) throw new AppError(`No approved Modrinth CDN download exists for ${item.path}.`);
      const destination = safeDestination(serverDirectory, item.path);
      const temporary = `${destination}.${crypto.randomUUID()}.open-mc-host-download`;
      try {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await download({
          url: downloadUrl,
          filename: path.basename(item.path),
          size: Number(item.fileSize || 0),
          hashes: item.hashes || {}
        }, temporary);
        await verifyHash(temporary, item.hashes);
        await fs.rename(temporary, destination);
        installedFiles += 1;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
    return { installedFiles, overrideFiles: overrideFiles.length };
  }
}

async function installOverrides(packPath, serverDirectory, entries) {
  const staging = path.join(path.dirname(packPath), `.open-mc-host-overrides-${crypto.randomUUID()}`);
  try {
    await fs.mkdir(staging, { recursive: false, mode: 0o700 });
    await command('unzip', ['-oq', packPath, 'overrides/*', '-d', staging]);
    const overridesRoot = path.join(staging, 'overrides');
    await assertRegularTree(overridesRoot);
    for (const entry of entries) {
      if (entry.endsWith('/')) continue;
      const relativePath = entry.slice('overrides/'.length);
      const source = safeDestination(overridesRoot, relativePath);
      const destination = safeDestination(serverDirectory, relativePath);
      await assertNoSymlinkParents(serverDirectory, destination);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await assertNoSymlinkParents(serverDirectory, destination);
      try {
        const existing = await fs.lstat(destination);
        if (existing.isSymbolicLink() || existing.isDirectory()) throw new AppError('The Modrinth overrides cannot replace that path.', 403);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.copyFile(source, destination);
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function assertRegularTree(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new AppError('The Modrinth overrides contain an unsupported file type.', 403);
  }
}

async function assertNoSymlinkParents(root, destination) {
  const parts = path.relative(root, destination).split(path.sep).slice(0, -1).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const stats = await fs.lstat(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new AppError('The Modrinth overrides attempted to traverse an unsafe path.', 403);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
}

function isAllowedDownload(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cdn.modrinth.com' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function command(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new AppError(`${binary} is unavailable: ${error.message}`, 503)));
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new AppError(stderr.trim() || `${binary} failed while unpacking the modpack.`, 502)));
  });
}

function safeArchivePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('..') && !path.isAbsolute(value) && !value.includes('\\');
}

function safeDestination(root, relativePath) {
  const destination = path.resolve(root, relativePath);
  if (!destination.startsWith(`${root}${path.sep}`)) throw new AppError('The Modrinth archive attempted to write outside server storage.', 403);
  return destination;
}

async function verifyHash(filePath, hashes = {}) {
  const algorithm = hashes.sha512 ? 'sha512' : hashes.sha1 ? 'sha1' : '';
  if (!algorithm) throw new AppError('The Modrinth archive is missing a file checksum.');
  const expected = hashes[algorithm].toLowerCase();
  const hash = crypto.createHash(algorithm);
  await new Promise((resolve, reject) => fsSync.createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject));
  if (hash.digest('hex') !== expected) throw new AppError('A downloaded Modrinth file failed checksum verification.', 502);
}

module.exports = { ModrinthClient, safeArchivePath, isAllowedDownload };
