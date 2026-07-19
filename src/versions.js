'use strict';

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_API_URL = 'https://fill.papermc.io/v3/projects/paper';
const DEFAULT_USER_AGENT = 'OpenMCHost/0.1.0 (https://github.com/jacobkobr/open-mc-host)';

const SOFTWARE = new Set(['PAPER', 'PURPUR', 'VANILLA', 'FABRIC', 'FORGE', 'NEOFORGE']);

class VersionCatalog {
  constructor({
    fetch: fetchImpl = globalThis.fetch,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    now = Date.now,
    userAgent = DEFAULT_USER_AGENT,
    mojangManifestUrl = MOJANG_MANIFEST_URL,
    paperApiUrl = PAPER_API_URL
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('VersionCatalog requires a fetch implementation.');
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new TypeError('cacheTtlMs must be a non-negative number.');
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    if (!identifyingUserAgent(userAgent)) throw new TypeError('userAgent must identify Open MC Host and include a contact URL or email address.');

    this.fetch = fetchImpl;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.userAgent = userAgent;
    this.mojangManifestUrl = mojangManifestUrl.replace(/\/$/, '');
    this.paperApiUrl = paperApiUrl.replace(/\/$/, '');
    this.cache = new Map();
  }

  async minecraftVersions({ software = 'VANILLA' } = {}) {
    normalizeSoftware(software);
    const versions = await this.cached('minecraft-releases', async () => {
      const manifest = await this.getJson(this.mojangManifestUrl);
      const latestRelease = typeof manifest?.latest?.release === 'string' ? manifest.latest.release : '';
      const seen = new Set();

      return (Array.isArray(manifest?.versions) ? manifest.versions : [])
        .filter((version) => version?.type === 'release' && exactVersion(version.id) && !seen.has(version.id) && seen.add(version.id))
        .map((version) => ({
          id: version.id,
          label: version.id === latestRelease ? `${version.id} (latest)` : version.id,
          type: 'release',
          stable: true,
          releaseTime: validDateString(version.releaseTime) || validDateString(version.time),
          latest: version.id === latestRelease
        }));
    });

    return clone(versions);
  }

  async serverBuilds({ software, minecraftVersion } = {}) {
    const normalizedSoftware = normalizeSoftware(software);
    const normalizedVersion = normalizeVersion(minecraftVersion);

    if (normalizedSoftware !== 'PAPER') {
      return [{
        id: normalizedVersion,
        label: normalizedVersion,
        channel: 'STABLE',
        downloadUrl: null,
        checksum: null,
        runtimeVersion: normalizedVersion
      }];
    }

    const builds = await this.cached(`paper-builds:${normalizedVersion}`, async () => {
      const encodedVersion = encodeURIComponent(normalizedVersion);
      const payload = await this.getJson(`${this.paperApiUrl}/versions/${encodedVersion}/builds`);
      if (!Array.isArray(payload)) throw upstreamError('Paper returned an invalid build list.');

      return payload
        .map((build) => normalizePaperBuild(build, normalizedVersion))
        .filter(Boolean)
        .sort(compareBuildsNewestFirst);
    });

    return clone(builds);
  }

  async resolve({ software, minecraftVersion, build } = {}) {
    const normalizedSoftware = normalizeSoftware(software);
    const normalizedVersion = normalizeVersion(minecraftVersion);
    const versions = await this.minecraftVersions({ software: normalizedSoftware });
    if (!versions.some((version) => version.id === normalizedVersion)) {
      const error = new Error(`Minecraft ${normalizedVersion} is not an available release.`);
      error.status = 400;
      throw error;
    }

    const builds = await this.serverBuilds({ software: normalizedSoftware, minecraftVersion: normalizedVersion });
    const requestedBuild = build == null || build === '' ? null : String(build).trim();
    const selected = requestedBuild ? builds.find((candidate) => candidate.id === requestedBuild) : builds[0];
    if (!selected) {
      const message = normalizedSoftware === 'PAPER'
        ? `Paper has no available ${requestedBuild ? `build ${requestedBuild}` : 'build'} for Minecraft ${normalizedVersion}.`
        : `${normalizedSoftware} uses Minecraft ${normalizedVersion} as its exact runtime version.`;
      const error = new Error(message);
      error.status = 400;
      throw error;
    }

    return {
      software: normalizedSoftware,
      minecraftVersion: normalizedVersion,
      build: selected.id,
      label: selected.label,
      channel: selected.channel,
      downloadUrl: selected.downloadUrl,
      checksum: selected.checksum,
      runtimeVersion: normalizedVersion,
      runtimeBuild: normalizedSoftware === 'PAPER' ? selected.id : null,
      runtime: {
        version: normalizedVersion,
        build: normalizedSoftware === 'PAPER' ? selected.id : null
      }
    };
  }

  clearCache() {
    this.cache.clear();
  }

  async cached(key, loader) {
    const current = this.cache.get(key);
    if (current && current.expiresAt > this.now()) return current.promise;

    const entry = {
      expiresAt: this.now() + this.cacheTtlMs,
      promise: Promise.resolve().then(loader)
    };
    this.cache.set(key, entry);
    try {
      return await entry.promise;
    } catch (error) {
      if (this.cache.get(key) === entry) this.cache.delete(key);
      throw error;
    }
  }

  async getJson(url) {
    let response;
    try {
      response = await this.fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': this.userAgent
        }
      });
    } catch (error) {
      throw upstreamError(`Version provider request failed: ${error.message}`);
    }

    if (!response?.ok) throw upstreamError(`Version provider request failed (${response?.status || 502}).`);
    try {
      return await response.json();
    } catch {
      throw upstreamError('Version provider returned invalid JSON.');
    }
  }
}

function normalizePaperBuild(build, minecraftVersion) {
  const channel = String(build?.channel || '').toUpperCase();
  if (!['STABLE', 'BETA', 'EXPERIMENTAL'].includes(channel)) return null;
  const rawId = build?.id ?? build?.number;
  if ((typeof rawId !== 'string' && typeof rawId !== 'number') || !String(rawId).trim()) return null;
  const id = String(rawId).trim();
  const download = build?.downloads?.['server:default'];
  const downloadUrl = typeof download?.url === 'string' && download.url.startsWith('https://') ? download.url : null;
  const checksum = typeof download?.checksums?.sha256 === 'string'
    ? { algorithm: 'sha256', value: download.checksums.sha256.toLowerCase() }
    : typeof download?.checksum === 'string'
      ? { algorithm: 'sha256', value: download.checksum.toLowerCase() }
      : null;

  return {
    id,
    label: `Build ${id}`,
    channel,
    downloadUrl,
    checksum,
    runtimeVersion: minecraftVersion,
    releaseTime: validDateString(build.time) || validDateString(build.createdAt)
  };
}

function compareBuildsNewestFirst(left, right) {
  const priority = { STABLE: 0, BETA: 1, EXPERIMENTAL: 2 };
  const channelDifference = (priority[left.channel] ?? 9) - (priority[right.channel] ?? 9);
  if (channelDifference) return channelDifference;
  const leftNumber = Number(left.id);
  const rightNumber = Number(right.id);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return rightNumber - leftNumber;
  return right.id.localeCompare(left.id, undefined, { numeric: true });
}

function normalizeSoftware(value) {
  const software = String(value || '').trim().toUpperCase();
  if (!SOFTWARE.has(software)) {
    const error = new Error(`Unsupported server software: ${software || '(missing)'}.`);
    error.status = 400;
    throw error;
  }
  return software;
}

function normalizeVersion(value) {
  const version = String(value || '').trim();
  if (!exactVersion(version)) {
    const error = new Error('An exact Minecraft release version is required.');
    error.status = 400;
    throw error;
  }
  return version;
}

function exactVersion(value) {
  return typeof value === 'string' && /^[0-9]+(?:\.[0-9]+){1,3}$/.test(value);
}

function validDateString(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function identifyingUserAgent(value) {
  return typeof value === 'string'
    && value.trim().length >= 12
    && /(https?:\/\/|[^\s@]+@[^\s@]+)/i.test(value);
}

function upstreamError(message) {
  const error = new Error(message);
  error.status = 502;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { VersionCatalog };
