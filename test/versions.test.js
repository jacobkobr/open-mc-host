'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VersionCatalog } = require('../src/versions');

const manifest = {
  latest: { release: '1.21.4', snapshot: '25w01a' },
  versions: [
    { id: '1.21.4', type: 'release', releaseTime: '2024-12-03T10:00:00Z' },
    { id: '25w01a', type: 'snapshot', releaseTime: '2025-01-01T10:00:00Z' },
    { id: '1.21.3', type: 'release', releaseTime: '2024-10-23T10:00:00Z' },
    { id: '1.21.3', type: 'release', releaseTime: '2024-10-23T10:00:00Z' },
    { id: 'not-a-version', type: 'release', releaseTime: 'invalid' }
  ]
};

test('returns normalized Mojang releases and caches the manifest', async () => {
  let calls = 0;
  const catalog = new VersionCatalog({
    fetch: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
      assert.match(options.headers['User-Agent'], /https:\/\//);
      return jsonResponse(manifest);
    }
  });

  const first = await catalog.minecraftVersions({ software: 'vanilla' });
  assert.deepEqual(first, [
    { id: '1.21.4', label: '1.21.4 (latest)', type: 'release', stable: true, releaseTime: '2024-12-03T10:00:00Z', latest: true },
    { id: '1.21.3', label: '1.21.3', type: 'release', stable: true, releaseTime: '2024-10-23T10:00:00Z', latest: false }
  ]);

  first[0].label = 'mutated';
  const second = await catalog.minecraftVersions({ software: 'fabric' });
  assert.equal(second[0].label, '1.21.4 (latest)');
  assert.equal(calls, 1);
});

test('refreshes cached provider data after the configured TTL', async () => {
  let currentTime = 100;
  let calls = 0;
  const catalog = new VersionCatalog({
    cacheTtlMs: 10,
    now: () => currentTime,
    fetch: async () => {
      calls += 1;
      return jsonResponse(manifest);
    }
  });

  await catalog.minecraftVersions({ software: 'VANILLA' });
  currentTime = 109;
  await catalog.minecraftVersions({ software: 'PAPER' });
  currentTime = 110;
  await catalog.minecraftVersions({ software: 'FORGE' });
  assert.equal(calls, 2);
});

test('returns exact Paper builds, preferring stable channels, with an identifying User-Agent', async () => {
  const requests = [];
  const catalog = new VersionCatalog({
    userAgent: 'OpenMCHost/1.0 (support@example.com)',
    fetch: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse([
        { id: 120, channel: 'BETA', downloads: { 'server:default': { url: 'https://example.test/beta.jar' } } },
        { id: 118, channel: 'STABLE', time: '2026-07-01T00:00:00Z', downloads: { 'server:default': { url: 'https://fill-data.papermc.io/build-118.jar', checksums: { sha256: 'AABB' } } } },
        { id: 121, channel: 'stable', downloads: { 'server:default': { url: 'https://fill-data.papermc.io/build-121.jar' } } },
        { channel: 'STABLE' }
      ]);
    }
  });

  const builds = await catalog.serverBuilds({ software: 'paper', minecraftVersion: '1.21.4' });
  assert.deepEqual(builds, [
    { id: '121', label: 'Build 121', channel: 'STABLE', downloadUrl: 'https://fill-data.papermc.io/build-121.jar', checksum: null, runtimeVersion: '1.21.4', releaseTime: null },
    { id: '118', label: 'Build 118', channel: 'STABLE', downloadUrl: 'https://fill-data.papermc.io/build-118.jar', checksum: { algorithm: 'sha256', value: 'aabb' }, runtimeVersion: '1.21.4', releaseTime: '2026-07-01T00:00:00Z' },
    { id: '120', label: 'Build 120', channel: 'BETA', downloadUrl: 'https://example.test/beta.jar', checksum: null, runtimeVersion: '1.21.4', releaseTime: null }
  ]);
  await catalog.serverBuilds({ software: 'PAPER', minecraftVersion: '1.21.4' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds');
  assert.equal(requests[0].options.headers['User-Agent'], 'OpenMCHost/1.0 (support@example.com)');
});

test('maps non-Paper software directly to the exact Minecraft runtime version', async () => {
  const catalog = new VersionCatalog({ fetch: async () => jsonResponse(manifest) });

  for (const software of ['PURPUR', 'VANILLA', 'FABRIC', 'FORGE', 'NEOFORGE']) {
    const builds = await catalog.serverBuilds({ software, minecraftVersion: '1.21.4' });
    assert.deepEqual(builds, [{ id: '1.21.4', label: '1.21.4', channel: 'STABLE', downloadUrl: null, checksum: null, runtimeVersion: '1.21.4' }]);

    const resolved = await catalog.resolve({ software, minecraftVersion: '1.21.4' });
    assert.equal(resolved.runtimeVersion, '1.21.4');
    assert.equal(resolved.runtimeBuild, null);
    assert.deepEqual(resolved.runtime, { version: '1.21.4', build: null });
  }
});

test('resolves an explicit Paper build and rejects unavailable exact selections', async () => {
  const catalog = new VersionCatalog({
    fetch: async (url) => url.includes('version_manifest')
      ? jsonResponse(manifest)
      : jsonResponse([
        { id: 12, channel: 'STABLE', downloads: { 'server:default': { url: 'https://fill-data.papermc.io/build-12.jar' } } },
        { id: 10, channel: 'STABLE', downloads: { 'server:default': { url: 'https://fill-data.papermc.io/build-10.jar' } } }
      ])
  });

  const resolved = await catalog.resolve({ software: 'PAPER', minecraftVersion: '1.21.4', build: '10' });
  assert.equal(resolved.build, '10');
  assert.equal(resolved.runtimeBuild, '10');
  assert.equal(resolved.downloadUrl, 'https://fill-data.papermc.io/build-10.jar');

  await assert.rejects(
    () => catalog.resolve({ software: 'PAPER', minecraftVersion: '1.21.4', build: '99' }),
    { status: 400 }
  );
  await assert.rejects(
    () => catalog.resolve({ software: 'VANILLA', minecraftVersion: '1.20.1' }),
    { status: 400 }
  );
  await assert.rejects(
    () => catalog.serverBuilds({ software: 'PAPER', minecraftVersion: 'LATEST' }),
    { status: 400 }
  );
});

test('does not retain failed provider requests in cache', async () => {
  let calls = 0;
  const catalog = new VersionCatalog({
    fetch: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ message: 'unavailable' }, 503);
      return jsonResponse(manifest);
    }
  });

  await assert.rejects(() => catalog.minecraftVersions(), { status: 502 });
  assert.equal((await catalog.minecraftVersions())[0].id, '1.21.4');
  assert.equal(calls, 2);
});

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; }
  };
}
