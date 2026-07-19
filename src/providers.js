const { AppError } = require('./errors');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'OpenMCHost/0.1.0 (https://github.com/jacobkobr/open-mc-host)';
const PROVIDERS = new Set(['modrinth', 'hangar']);
const DOWNLOAD_HOSTS = Object.freeze({
  modrinth: new Set(['cdn.modrinth.com']),
  hangar: new Set(['hangarcdn.papermc.io'])
});

class ProviderCatalog {
  constructor(options = {}) {
    this.providers = new Map([
      ['modrinth', new ModrinthProvider(options)],
      ['hangar', new HangarProvider(options)]
    ]);
  }

  provider(name) {
    const normalized = normalizeProvider(name);
    return this.providers.get(normalized);
  }

  async search(provider, options) {
    return this.provider(provider).search(options);
  }

  async versions(provider, options) {
    return this.provider(provider).versions(options);
  }

  async listVersions(provider, options) {
    return this.versions(provider, options);
  }

  async download(provider, options) {
    return this.provider(provider).download(options);
  }

  async downloadMetadata(provider, options) {
    return this.download(provider, options);
  }
}

class ProviderClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = DEFAULT_USER_AGENT } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A backend fetch implementation is required.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new TypeError('Provider timeout must be between 100 and 60000 milliseconds.');
    if (typeof userAgent !== 'string' || userAgent.trim().length < 10 || userAgent.length > 200) throw new TypeError('Provider user agent must identify the application.');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent.trim();
  }

  async requestJson(url, provider) {
    assertApiUrl(url, provider);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    let response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': this.userAgent
        },
        redirect: 'error',
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') throw new AppError(`${displayName(provider)} did not respond before the timeout.`, 504);
      throw new AppError(`${displayName(provider)} could not be reached.`, 502);
    } finally {
      clearTimeout(timeout);
    }

    if (!response || typeof response.ok !== 'boolean') throw new AppError(`${displayName(provider)} returned an invalid response.`, 502);
    if (!response.ok) {
      const status = Number(response.status) === 404 ? 404 : 502;
      throw new AppError(`${displayName(provider)} request failed (${Number(response.status) || 'unknown'}).`, status);
    }

    try {
      return await response.json();
    } catch {
      throw new AppError(`${displayName(provider)} returned invalid JSON.`, 502);
    }
  }
}

class ModrinthProvider extends ProviderClient {
  async search(options = {}) {
    const query = normalizeQuery(options.query);
    const pagination = normalizePagination(options);
    const kind = normalizeKind(options.kind, 'plugin');
    const gameVersion = optionalVersion(options.gameVersion, 'Minecraft version');
    const loader = optionalIdentifier(options.loader, 'loader', 32)?.toLowerCase();
    const sort = normalizeChoice(options.sort || 'relevance', ['relevance', 'downloads', 'follows', 'newest', 'updated'], 'sort');
    const facets = [[`all_project_types:${kind}`]];
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    if (loader) facets.push([`categories:${loader}`]);

    const url = new URL('https://api.modrinth.com/v2/search');
    url.searchParams.set('query', query);
    url.searchParams.set('facets', JSON.stringify(facets));
    url.searchParams.set('index', sort);
    url.searchParams.set('limit', String(pagination.limit));
    url.searchParams.set('offset', String(pagination.offset));
    const body = await this.requestJson(url, 'modrinth');
    if (!isRecord(body) || !Array.isArray(body.hits)) throw upstreamShapeError('modrinth');

    return {
      provider: 'modrinth',
      query,
      items: body.hits.map(normalizeModrinthProject),
      pagination: {
        offset: safeInteger(body.offset, pagination.offset),
        limit: safeInteger(body.limit, pagination.limit),
        total: safeInteger(body.total_hits, body.hits.length)
      }
    };
  }

  async versions(options = {}) {
    const projectId = normalizeIdentifier(options.projectId, 'Modrinth project ID', 64);
    const pagination = normalizePagination(options);
    const gameVersion = optionalVersion(options.gameVersion, 'Minecraft version');
    const loader = optionalIdentifier(options.loader, 'loader', 32)?.toLowerCase();
    const url = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
    if (gameVersion) url.searchParams.set('game_versions', JSON.stringify([gameVersion]));
    if (loader) url.searchParams.set('loaders', JSON.stringify([loader]));
    url.searchParams.set('include_changelog', 'false');
    const body = await this.requestJson(url, 'modrinth');
    if (!Array.isArray(body)) throw upstreamShapeError('modrinth');
    const items = body.slice(pagination.offset, pagination.offset + pagination.limit).map(normalizeModrinthVersion);

    return {
      provider: 'modrinth',
      projectId,
      items,
      pagination: { offset: pagination.offset, limit: pagination.limit, total: body.length }
    };
  }

  async download(options = {}) {
    const versionId = normalizeIdentifier(options.versionId, 'Modrinth version ID', 64);
    const expectedProjectId = options.projectId ? normalizeIdentifier(options.projectId, 'Modrinth project ID', 64) : null;
    const filename = optionalFilename(options.filename);
    const url = new URL(`https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`);
    const body = await this.requestJson(url, 'modrinth');
    const version = normalizeModrinthVersion(body);
    if (expectedProjectId && version.projectId !== expectedProjectId) throw new AppError('The selected Modrinth version does not belong to that project.', 409);
    const file = selectFile(version.files, filename);
    requireChecksum(file, 'modrinth');
    return exactDownload('modrinth', version, file);
  }
}

class HangarProvider extends ProviderClient {
  async search(options = {}) {
    const query = normalizeQuery(options.query);
    const pagination = normalizePagination(options);
    const kind = normalizeKind(options.kind, 'plugin');
    if (kind !== 'plugin') throw new AppError('Hangar only provides server plugins.', 400);
    const platform = normalizeHangarPlatform(options.platform || options.loader || 'paper');
    const gameVersion = optionalVersion(options.gameVersion, 'Minecraft version');
    const url = new URL('https://hangar.papermc.io/api/v1/projects');
    url.searchParams.set('query', query);
    url.searchParams.set('platform', platform);
    if (gameVersion) url.searchParams.set('version', gameVersion);
    url.searchParams.set('limit', String(pagination.limit));
    url.searchParams.set('offset', String(pagination.offset));
    const body = await this.requestJson(url, 'hangar');
    if (!isRecord(body) || !Array.isArray(body.result)) throw upstreamShapeError('hangar');

    return {
      provider: 'hangar',
      query,
      items: body.result.map(normalizeHangarProject),
      pagination: normalizeHangarPagination(body.pagination, pagination, body.result.length)
    };
  }

  async versions(options = {}) {
    const projectId = normalizeIdentifier(options.projectId, 'Hangar project ID', 64);
    const pagination = normalizePagination(options);
    const platform = normalizeHangarPlatform(options.platform || options.loader || 'paper');
    const gameVersion = optionalVersion(options.gameVersion, 'Minecraft version');
    const url = new URL(`https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(projectId)}/versions`);
    url.searchParams.set('platform', platform);
    if (gameVersion) url.searchParams.set('platformVersion', gameVersion);
    url.searchParams.set('limit', String(pagination.limit));
    url.searchParams.set('offset', String(pagination.offset));
    const body = await this.requestJson(url, 'hangar');
    if (!isRecord(body) || !Array.isArray(body.result)) throw upstreamShapeError('hangar');

    return {
      provider: 'hangar',
      projectId,
      items: body.result.map(normalizeHangarVersion),
      pagination: normalizeHangarPagination(body.pagination, pagination, body.result.length)
    };
  }

  async download(options = {}) {
    const projectId = normalizeIdentifier(options.projectId, 'Hangar project ID', 64);
    const versionId = normalizeHangarVersionId(options.versionId);
    const platform = normalizeHangarPlatform(options.platform || options.loader || 'paper');
    const url = new URL(`https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`);
    const body = await this.requestJson(url, 'hangar');
    const version = normalizeHangarVersion(body);
    const file = version.files.find((item) => item.platform === platform);
    if (!file) throw new AppError(`The selected Hangar version has no ${platform} download.`, 404);
    requireChecksum(file, 'hangar');
    return exactDownload('hangar', version, file);
  }
}

function normalizeModrinthProject(item) {
  if (!isRecord(item)) throw upstreamShapeError('modrinth');
  const id = responseString(item.project_id, 'project ID', 'modrinth');
  const slug = responseString(item.slug, 'project slug', 'modrinth');
  const projectTypes = stringArray(item.all_project_types);
  const projectType = projectTypes.includes('plugin') ? 'plugin' : responseString(item.project_type, 'project type', 'modrinth');
  return {
    provider: 'modrinth',
    id,
    slug,
    name: responseString(item.title, 'project title', 'modrinth'),
    summary: nullableString(item.description),
    author: nullableString(item.author),
    iconUrl: optionalAssetUrl(item.icon_url, 'modrinth'),
    websiteUrl: `https://modrinth.com/${projectType}/${encodeURIComponent(slug)}`,
    projectType,
    downloads: safeInteger(item.downloads, 0),
    updatedAt: nullableString(item.date_modified),
    categories: stringArray(item.categories),
    gameVersions: stringArray(item.versions),
    loaders: stringArray(item.display_categories).filter((value) => ['bukkit', 'fabric', 'forge', 'neoforge', 'paper', 'purpur', 'quilt', 'spigot'].includes(value.toLowerCase())),
    serverSide: nullableString(item.server_side)
  };
}

function normalizeHangarProject(item) {
  if (!isRecord(item) || !isRecord(item.namespace)) throw upstreamShapeError('hangar');
  const slug = responseString(item.namespace.slug, 'project slug', 'hangar');
  const author = responseString(item.namespace.owner, 'project owner', 'hangar');
  const supportedPlatforms = isRecord(item.supportedPlatforms) ? item.supportedPlatforms : {};
  return {
    provider: 'hangar',
    id: slug,
    providerId: String(item.id),
    slug,
    name: responseString(item.name, 'project name', 'hangar'),
    summary: nullableString(item.description),
    author,
    iconUrl: optionalAssetUrl(item.avatarUrl, 'hangar'),
    websiteUrl: `https://hangar.papermc.io/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`,
    projectType: 'plugin',
    downloads: safeInteger(item.stats?.downloads, 0),
    updatedAt: nullableString(item.lastUpdated),
    categories: item.category ? [String(item.category)] : [],
    gameVersions: stringArray(supportedPlatforms.PAPER),
    loaders: Object.keys(supportedPlatforms).map((value) => value.toLowerCase()),
    serverSide: 'required'
  };
}

function normalizeModrinthVersion(item) {
  if (!isRecord(item) || !Array.isArray(item.files)) throw upstreamShapeError('modrinth');
  const files = item.files.map((file) => normalizeModrinthFile(file));
  return {
    provider: 'modrinth',
    projectId: responseString(item.project_id, 'project ID', 'modrinth'),
    id: responseString(item.id, 'version ID', 'modrinth'),
    name: responseString(item.name || item.version_number, 'version name', 'modrinth'),
    versionNumber: responseString(item.version_number, 'version number', 'modrinth'),
    releaseChannel: nullableString(item.version_type) || 'release',
    publishedAt: nullableString(item.date_published),
    gameVersions: stringArray(item.game_versions),
    loaders: stringArray(item.loaders).map((value) => value.toLowerCase()),
    downloads: safeInteger(item.downloads, 0),
    dependencies: Array.isArray(item.dependencies) ? item.dependencies.map(normalizeModrinthDependency) : [],
    files
  };
}

function normalizeModrinthFile(item) {
  if (!isRecord(item)) throw upstreamShapeError('modrinth');
  return {
    filename: responseFilename(item.filename, 'modrinth'),
    size: safeInteger(item.size, 0),
    url: assertAllowedDownloadUrl(item.url, 'modrinth'),
    primary: item.primary === true,
    platform: null,
    hashes: normalizeHashes(item.hashes, 'modrinth')
  };
}

function normalizeModrinthDependency(item) {
  if (!isRecord(item)) throw upstreamShapeError('modrinth');
  return {
    projectId: nullableString(item.project_id),
    versionId: nullableString(item.version_id),
    name: nullableString(item.file_name),
    type: nullableString(item.dependency_type) || 'unknown',
    required: item.dependency_type === 'required',
    externalUrl: null
  };
}

function normalizeHangarVersion(item) {
  if (!isRecord(item) || !isRecord(item.downloads)) throw upstreamShapeError('hangar');
  const files = Object.entries(item.downloads).map(([platform, download]) => normalizeHangarFile(platform, download));
  const dependencies = [];
  if (isRecord(item.pluginDependencies)) {
    for (const [platform, values] of Object.entries(item.pluginDependencies)) {
      if (!Array.isArray(values)) continue;
      for (const dependency of values) dependencies.push(normalizeHangarDependency(platform, dependency));
    }
  }
  const platformDependencies = isRecord(item.platformDependencies) ? item.platformDependencies : {};
  return {
    provider: 'hangar',
    projectId: String(item.projectId),
    id: String(item.id),
    name: responseString(item.name, 'version name', 'hangar'),
    versionNumber: responseString(item.name, 'version name', 'hangar'),
    releaseChannel: nullableString(item.channel?.name)?.toLowerCase() || 'release',
    publishedAt: nullableString(item.createdAt),
    gameVersions: stringArray(platformDependencies.PAPER),
    loaders: Object.keys(platformDependencies).map((value) => value.toLowerCase()),
    downloads: safeInteger(item.stats?.totalDownloads, 0),
    dependencies,
    files
  };
}

function normalizeHangarFile(platform, item) {
  if (!isRecord(item) || !isRecord(item.fileInfo)) throw upstreamShapeError('hangar');
  if (!item.downloadUrl) {
    if (item.externalUrl) throw new AppError('Hangar returned an external download that Open MC Host will not install automatically.', 422);
    throw upstreamShapeError('hangar');
  }
  return {
    filename: responseFilename(item.fileInfo.name, 'hangar'),
    size: safeInteger(item.fileInfo.sizeBytes, 0),
    url: assertAllowedDownloadUrl(item.downloadUrl, 'hangar'),
    primary: platform.toUpperCase() === 'PAPER',
    platform: platform.toUpperCase(),
    hashes: normalizeHashes({ sha256: item.fileInfo.sha256Hash }, 'hangar')
  };
}

function normalizeHangarDependency(platform, item) {
  if (!isRecord(item)) throw upstreamShapeError('hangar');
  return {
    projectId: item.projectId === null || item.projectId === undefined ? null : String(item.projectId),
    versionId: null,
    name: nullableString(item.name),
    type: item.required === true ? 'required' : 'optional',
    required: item.required === true,
    externalUrl: safeExternalReference(item.externalUrl),
    platform: String(item.platform || platform).toUpperCase()
  };
}

function exactDownload(provider, version, file) {
  return {
    provider,
    projectId: version.projectId,
    versionId: version.id,
    versionNumber: version.versionNumber,
    releaseChannel: version.releaseChannel,
    gameVersions: version.gameVersions,
    loaders: version.loaders,
    dependencies: version.dependencies,
    file
  };
}

function selectFile(files, filename) {
  if (!Array.isArray(files) || files.length === 0) throw new AppError('The selected version has no downloadable file.', 404);
  if (filename) {
    const exact = files.find((file) => file.filename === filename);
    if (!exact) throw new AppError('The selected file does not exist in that version.', 404);
    return exact;
  }
  return files.find((file) => file.primary) || files[0];
}

function requireChecksum(file, provider) {
  if (!file || Object.keys(file.hashes).length === 0) throw new AppError(`${displayName(provider)} did not provide a checksum for this file.`, 502);
}

function normalizeHashes(value, provider) {
  if (!isRecord(value)) return {};
  const hashes = {};
  for (const [algorithm, length] of Object.entries({ sha1: 40, sha256: 64, sha512: 128 })) {
    if (value[algorithm] === undefined || value[algorithm] === null) continue;
    const hash = String(value[algorithm]).toLowerCase();
    if (!new RegExp(`^[a-f0-9]{${length}}$`).test(hash)) throw new AppError(`${displayName(provider)} returned an invalid ${algorithm} checksum.`, 502);
    hashes[algorithm] = hash;
  }
  return hashes;
}

function assertAllowedDownloadUrl(value, provider) {
  const normalizedProvider = normalizeProvider(provider);
  let url;
  try { url = new URL(value); } catch { throw new AppError(`${displayName(normalizedProvider)} returned an invalid download URL.`, 502); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !DOWNLOAD_HOSTS[normalizedProvider].has(url.hostname.toLowerCase())) {
    throw new AppError(`${displayName(normalizedProvider)} returned an unapproved download host.`, 502);
  }
  return url.toString();
}

function assertApiUrl(url, provider) {
  const allowedHost = provider === 'modrinth' ? 'api.modrinth.com' : 'hangar.papermc.io';
  if (!(url instanceof URL) || url.protocol !== 'https:' || url.hostname !== allowedHost || url.port || url.username || url.password) {
    throw new AppError(`An invalid ${displayName(provider)} API URL was rejected.`, 500);
  }
}

function normalizeProvider(value) {
  const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!PROVIDERS.has(provider)) throw new AppError('Provider must be modrinth or hangar.', 400);
  return provider;
}

function normalizeQuery(value) {
  if (typeof value !== 'string') throw new AppError('Search query is required.', 400);
  const query = value.trim();
  if (query.length < 2 || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query)) throw new AppError('Search query must contain 2 to 100 printable characters.', 400);
  return query;
}

function normalizePagination({ limit = 20, offset = 0 } = {}) {
  const normalizedLimit = Number(limit);
  const normalizedOffset = Number(offset);
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 25) throw new AppError('Provider result limit must be between 1 and 25.', 400);
  if (!Number.isInteger(normalizedOffset) || normalizedOffset < 0 || normalizedOffset > 10_000) throw new AppError('Provider result offset must be between 0 and 10000.', 400);
  return { limit: normalizedLimit, offset: normalizedOffset };
}

function normalizeKind(value, fallback) {
  return normalizeChoice(value || fallback, ['mod', 'plugin', 'modpack'], 'project type');
}

function normalizeChoice(value, choices, field) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!choices.includes(normalized)) throw new AppError(`${field} must be one of: ${choices.join(', ')}.`, 400);
  return normalized;
}

function normalizeIdentifier(value, field, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new AppError(`${field} is required.`, 400);
  const normalized = String(value).trim();
  if (!new RegExp(`^[A-Za-z0-9_-]{1,${maxLength}}$`).test(normalized)) throw new AppError(`${field} is invalid.`, 400);
  return normalized;
}

function optionalIdentifier(value, field, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeIdentifier(value, field, maxLength);
}

function normalizeHangarVersionId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new AppError('Hangar version ID is required.', 400);
  const normalized = String(value).trim();
  if (!/^[A-Za-z0-9._+:-]{1,128}$/.test(normalized)) throw new AppError('Hangar version ID is invalid.', 400);
  return normalized;
}

function optionalVersion(value, field) {
  if (value === undefined || value === null || value === '' || value === 'LATEST') return null;
  if (typeof value !== 'string') throw new AppError(`${field} is invalid.`, 400);
  const normalized = value.trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/.test(normalized)) throw new AppError(`${field} is invalid.`, 400);
  return normalized;
}

function normalizeHangarPlatform(value) {
  return normalizeChoice(value, ['paper', 'velocity', 'waterfall'], 'Hangar platform').toUpperCase();
}

function optionalFilename(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 255 || !/^[^/\\\u0000-\u001f\u007f]+$/.test(value)) throw new AppError('File name is invalid.', 400);
  return value;
}

function responseFilename(value, provider) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || !/^[^/\\\u0000-\u001f\u007f]+$/.test(value)) throw upstreamShapeError(provider);
  return value;
}

function responseString(value, field, provider) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) throw new AppError(`${displayName(provider)} returned an invalid ${field}.`, 502);
  return String(value);
}

function nullableString(value) {
  return typeof value === 'string' && value.length ? value : null;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 500) : [];
}

function optionalAssetUrl(value, provider) {
  if (!value) return null;
  try { return assertAllowedDownloadUrl(value, provider); } catch { return null; }
}

function safeExternalReference(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeHangarPagination(value, fallback, resultCount) {
  return {
    offset: safeInteger(value?.offset, fallback.offset),
    limit: safeInteger(value?.limit, fallback.limit),
    total: safeInteger(value?.count, resultCount)
  };
}

function safeInteger(value, fallback) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : fallback;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function upstreamShapeError(provider) {
  return new AppError(`${displayName(provider)} returned an unexpected response.`, 502);
}

function displayName(provider) {
  return provider === 'modrinth' ? 'Modrinth' : provider === 'hangar' ? 'Hangar' : 'Provider';
}

module.exports = {
  ProviderCatalog,
  ModrinthProvider,
  HangarProvider,
  assertAllowedDownloadUrl,
  DEFAULT_USER_AGENT
};
