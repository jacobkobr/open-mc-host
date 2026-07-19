const test = require('node:test');
const assert = require('node:assert/strict');
const { DockerRuntime, dockerMemoryLimit, javaMajorForMinecraft, parsePlayerList, parsePanelBindings, calculateUptime } = require('../src/runtime');

test('selects a compatible Java runtime for pinned Minecraft releases', () => {
  assert.equal(javaMajorForMinecraft('1.16.5'), 8);
  assert.equal(javaMajorForMinecraft('1.20.4'), 17);
  assert.equal(javaMajorForMinecraft('1.20.5'), 21);
  assert.equal(javaMajorForMinecraft('1.21.8'), 21);
  assert.equal(javaMajorForMinecraft('26.2'), 25);
  const runtime = new DockerRuntime({ dataDir: '.', dockerDataDir: '.', image: 'itzg/minecraft-server:java25' });
  assert.equal(runtime.runtimeImage({ version: '1.16.5' }), 'itzg/minecraft-server:java8');
  assert.equal(runtime.runtimeImage({ version: '1.21.8' }), 'itzg/minecraft-server:java21');
  assert.equal(runtime.runtimeImage({ version: '26.2' }), 'itzg/minecraft-server:java25');
});

test('leaves headroom above the configured Java heap', () => {
  assert.equal(dockerMemoryLimit('2G'), '2816M');
  assert.equal(dockerMemoryLimit('4096M'), '5120M');
});

test('normalizes player counts and effective dashboard port exposure', () => {
  assert.deepEqual(parsePlayerList('There are 2 of a max of 20 players online: Alex, Steve'), { playersOnline: 2, maxPlayers: 20, players: ['Alex', 'Steve'] });
  assert.deepEqual(parsePlayerList('RCON unavailable'), { playersOnline: null, maxPlayers: null, players: [] });
  assert.deepEqual(parsePanelBindings({ '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3000' }] }, 3000), {
    published: true, loopbackOnly: true, exposure: 'loopback-only', bindings: [{ hostIp: '127.0.0.1', hostPort: 3000 }]
  });
  assert.equal(parsePanelBindings({ '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3000' }] }, 3000).exposure, 'public-or-network');
  assert.equal(parsePanelBindings({}, 3000).exposure, 'unpublished');
  assert.equal(calculateUptime('2026-07-18T00:00:00.000Z', Date.parse('2026-07-18T01:00:05.000Z')), 3605);
  assert.equal(calculateUptime('invalid'), null);
});

test('creates an exact, constrained Minecraft container on all host interfaces', async () => {
  const calls = [];
  const runtime = new DockerRuntime({
    dataDir: '.', dockerDataDir: '/var/lib/open-mc-host', image: 'itzg/minecraft-server:java25',
    runner: async (command, args) => { calls.push({ command, args }); return 'container-id'; }
  });
  await runtime.create({
    id: 'server-id', containerName: 'open-mc-host-server-id', port: 25570, cpus: 2, memory: '4G', memoryLimit: '5G',
    software: 'PAPER', version: '1.21.8', build: '42', name: 'Exact Paper', rconPassword: 'secret'
  });
  const args = calls[0].args;
  assert.equal(calls[0].command, 'docker');
  assert.ok(args.includes('0.0.0.0:25570:25565'));
  assert.ok(args.includes('VERSION=1.21.8'));
  assert.ok(args.includes('PAPER_BUILD=42'));
  assert.ok(args.includes('no-new-privileges:true'));
  assert.deepEqual(args.slice(args.indexOf('--cpus'), args.indexOf('--cpus') + 2), ['--cpus', '2']);
  assert.deepEqual(args.slice(args.indexOf('--memory'), args.indexOf('--memory') + 2), ['--memory', '5G']);
  assert.equal(args.at(-1), 'itzg/minecraft-server:java21');
});

test('loads a complete console log only when requested', async () => {
  const calls = [];
  const runtime = new DockerRuntime({ dataDir: '.', dockerDataDir: '.', image: 'itzg/minecraft-server:java25', runner: async (command, args) => { calls.push({ command, args }); return 'logs'; } });
  await runtime.logs({ containerName: 'open-mc-host-test' }, 500);
  await runtime.logs({ containerName: 'open-mc-host-test' }, 'all', { since: '2026-07-18T12:00:00.000Z', until: '2026-07-18T13:00:00.000Z' });
  assert.deepEqual(calls[0].args, ['logs', '--timestamps', '--tail', '500', 'open-mc-host-test']);
  assert.deepEqual(calls[1].args, ['logs', '--timestamps', '--since', '2026-07-18T12:00:00.000Z', '--until', '2026-07-18T13:00:00.000Z', 'open-mc-host-test']);
});
