const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ProviderCatalog,
  ModrinthProvider,
  HangarProvider,
  assertAllowedDownloadUrl,
  DEFAULT_USER_AGENT
} = require('../src/providers');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function modrinthFile(overrides = {}) {
  return {
    filename: 'example.jar',
    size: 1234,
    url: 'https://cdn.modrinth.com/data/abc/versions/def/example.jar',
    primary: true,
    hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
    ...overrides
  };
}

function modrinthVersion(overrides = {}) {
  return {
    project_id: 'project1',
    id: 'version1',
    name: 'Example 1.0',
    version_number: '1.0.0',
    version_type: 'release',
    date_published: '2026-07-01T00:00:00Z',
    game_versions: ['1.21.8'],
    loaders: ['paper'],
    downloads: 42,
    dependencies: [{ project_id: 'required1', version_id: null, dependency_type: 'required' }],
    files: [modrinthFile()],
    ...overrides
  };
}

function hangarVersion(overrides = {}) {
  return {
    createdAt: '2026-07-01T00:00:00Z',
    id: 22,
    projectId: 11,
    name: '2.0.0',
    channel: { name: 'Release' },
    stats: { totalDownloads: 15 },
    downloads: {
      PAPER: {
        fileInfo: { name: 'plugin.jar', sizeBytes: 2500, sha256Hash: 'c'.repeat(64) },
        externalUrl: null,
        downloadUrl: 'https://hangarcdn.papermc.io/plugins/Owner/Plugin/versions/2.0.0/PAPER/plugin.jar'
      }
    },
    pluginDependencies: {
      PAPER: [{ name: 'Dependency', projectId: 99, required: true, externalUrl: null, platform: 'PAPER' }]
    },
    platformDependencies: { PAPER: ['1.21.8'] },
    ...overrides
  };
}

test('normalizes Modrinth search and sends constrained facets with an identifying user agent', async () => {
  let request;
  const provider = new ModrinthProvider({
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return response({
        offset: 0,
        limit: 10,
        total_hits: 1,
        hits: [{
          project_id: 'project1', slug: 'example', title: 'Example', description: 'A plugin', author: 'Owner',
          icon_url: 'https://cdn.modrinth.com/data/project1/icon.png', project_type: 'mod', all_project_types: ['plugin'],
          downloads: 100, date_modified: '2026-07-01T00:00:00Z', categories: ['utility', 'paper'],
          display_categories: ['paper'], versions: ['1.21.8'], server_side: 'required'
        }]
      });
    }
  });

  const result = await provider.search({ query: '  Example  ', kind: 'plugin', gameVersion: '1.21.8', loader: 'paper', limit: 10 });
  assert.equal(request.url.hostname, 'api.modrinth.com');
  assert.equal(request.url.searchParams.get('query'), 'Example');
  assert.deepEqual(JSON.parse(request.url.searchParams.get('facets')), [
    ['all_project_types:plugin'], ['versions:1.21.8'], ['categories:paper']
  ]);
  assert.equal(request.options.headers['user-agent'], DEFAULT_USER_AGENT);
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(result.pagination, { offset: 0, limit: 10, total: 1 });
  assert.deepEqual(result.items[0], {
    provider: 'modrinth', id: 'project1', slug: 'example', name: 'Example', summary: 'A plugin', author: 'Owner',
    iconUrl: 'https://cdn.modrinth.com/data/project1/icon.png', websiteUrl: 'https://modrinth.com/plugin/example',
    projectType: 'plugin', downloads: 100, updatedAt: '2026-07-01T00:00:00Z', categories: ['utility', 'paper'],
    gameVersions: ['1.21.8'], loaders: ['paper'], serverSide: 'required'
  });
});

test('lists normalized Modrinth versions and returns exact checksum download metadata', async () => {
  const calls = [];
  const provider = new ModrinthProvider({
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return response(url.includes('/version/version1') ? modrinthVersion() : [modrinthVersion()]);
    }
  });
  const listed = await provider.versions({ projectId: 'project1', gameVersion: '1.21.8', loader: 'paper' });
  assert.equal(calls[0].searchParams.get('include_changelog'), 'false');
  assert.deepEqual(listed.items[0].dependencies[0], {
    projectId: 'required1', versionId: null, name: null, type: 'required', required: true, externalUrl: null
  });
  const exact = await provider.download({ projectId: 'project1', versionId: 'version1' });
  assert.equal(exact.versionNumber, '1.0.0');
  assert.equal(exact.file.filename, 'example.jar');
  assert.deepEqual(exact.file.hashes, { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) });
});

test('normalizes Hangar project search and Paper compatibility', async () => {
  let requestUrl;
  const provider = new HangarProvider({
    fetchImpl: async (url) => {
      requestUrl = new URL(url);
      return response({
        pagination: { count: 1, limit: 20, offset: 0 },
        result: [{
          id: 11, name: 'Plugin', namespace: { owner: 'Owner', slug: 'Plugin' }, description: 'Useful plugin',
          stats: { downloads: 500 }, category: 'admin_tools', lastUpdated: '2026-07-01T00:00:00Z',
          avatarUrl: 'https://hangarcdn.papermc.io/avatars/project/11.webp', supportedPlatforms: { PAPER: ['1.21.8'] }
        }]
      });
    }
  });
  const result = await provider.search({ query: 'Plugin', gameVersion: '1.21.8' });
  assert.equal(requestUrl.searchParams.get('platform'), 'PAPER');
  assert.equal(requestUrl.searchParams.get('version'), '1.21.8');
  assert.equal(result.items[0].id, 'Plugin');
  assert.equal(result.items[0].providerId, '11');
  assert.equal(result.items[0].websiteUrl, 'https://hangar.papermc.io/Owner/Plugin');
  assert.deepEqual(result.items[0].gameVersions, ['1.21.8']);
  assert.deepEqual(result.items[0].loaders, ['paper']);
});

test('lists and resolves exact Hangar versions with official CDN and sha256 metadata', async () => {
  const calls = [];
  const provider = new HangarProvider({
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return response(url.endsWith('/versions/2.0.0')
        ? hangarVersion()
        : { pagination: { count: 1, limit: 20, offset: 0 }, result: [hangarVersion()] });
    }
  });
  const listed = await provider.versions({ projectId: 'Plugin', gameVersion: '1.21.8' });
  assert.equal(calls[0].searchParams.get('platformVersion'), '1.21.8');
  assert.equal(listed.items[0].files[0].platform, 'PAPER');
  assert.equal(listed.items[0].dependencies[0].required, true);
  const exact = await provider.download({ projectId: 'Plugin', versionId: '2.0.0', platform: 'paper' });
  assert.deepEqual(exact.file.hashes, { sha256: 'c'.repeat(64) });
  assert.equal(exact.file.url, 'https://hangarcdn.papermc.io/plugins/Owner/Plugin/versions/2.0.0/PAPER/plugin.jar');
});

test('catalog validates provider names, input, project ownership, and download hosts', async () => {
  const catalog = new ProviderCatalog({ fetchImpl: async () => response(modrinthVersion()) });
  await assert.rejects(() => catalog.search('unknown', { query: 'test' }), { status: 400 });
  await assert.rejects(() => catalog.search('modrinth', { query: 'x' }), { status: 400 });
  await assert.rejects(() => catalog.download('modrinth', { projectId: 'other', versionId: 'version1' }), { status: 409 });
  assert.throws(() => assertAllowedDownloadUrl('https://evil.example/plugin.jar', 'hangar'), { status: 502 });
  assert.throws(() => assertAllowedDownloadUrl('http://cdn.modrinth.com/plugin.jar', 'modrinth'), { status: 502 });
});

test('rejects provider timeouts and external Hangar downloads', async () => {
  const timeoutProvider = new ModrinthProvider({
    timeoutMs: 100,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })
  });
  await assert.rejects(() => timeoutProvider.search({ query: 'Example' }), { status: 504 });

  const externalProvider = new HangarProvider({
    fetchImpl: async () => response(hangarVersion({
      downloads: {
        PAPER: {
          fileInfo: { name: 'plugin.jar', sizeBytes: 1, sha256Hash: 'd'.repeat(64) },
          externalUrl: 'https://github.com/example/plugin.jar',
          downloadUrl: null
        }
      }
    }))
  });
  await assert.rejects(() => externalProvider.download({ projectId: 'Plugin', versionId: '2.0.0' }), { status: 422 });
});
