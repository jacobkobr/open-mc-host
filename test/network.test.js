const test = require('node:test');
const assert = require('node:assert/strict');
const { NetworkService, hasExternalPlayerConnection, isPrivateIpv4 } = require('../src/network');

test('reports a published game port without claiming external reachability', async () => {
  const runtime = {
    async status() { return 'running'; },
    async portBinding() { return { published: true, hostPort: 25565, hostIp: '0.0.0.0', allInterfaces: true }; },
    async logs() { return '[Server thread/INFO]: Ready'; }
  };
  const network = new NetworkService({ runtime, lanIp: '192.168.1.50', publicIpResolver: async () => '198.51.100.44', tcpProbe: async () => true });
  const result = await network.check({ id: 'server-id', port: 25565 });
  assert.equal(result.runningLocally, true);
  assert.equal(result.lan.joinAddress, '192.168.1.50:25565');
  assert.equal(result.public.joinAddress, '198.51.100.44:25565');
  assert.equal(result.public.portState, 'not-confirmed');
  assert.equal(result.public.probeFromHost, true);
  assert.equal(result.statuses.find((item) => item.id === 'lan').label, 'LAN reachable');
});

test('marks public reachability only after an external player connection appears in logs', async () => {
  const runtime = {
    async status() { return 'running'; },
    async portBinding() { return { published: true, hostPort: 25565, hostIp: '0.0.0.0', allInterfaces: true }; },
    async logs() { return '[Server thread/INFO]: Alex[/8.8.8.8:49152] logged in with entity id 1'; }
  };
  const network = new NetworkService({ runtime, lanIp: '192.168.1.50', publicIpResolver: async () => '198.51.100.44', tcpProbe: async () => true });
  const result = await network.check({ id: 'server-id', port: 25565 });
  assert.equal(result.public.externallyConfirmed, true);
  assert.equal(result.public.portState, 'publicly-reachable');
  assert.equal(hasExternalPlayerConnection('Alex[/192.168.1.12:49152] logged in'), false);
  assert.equal(isPrivateIpv4('192.168.1.12'), true);
});

test('uses cloud-specific private address guidance without router forwarding values', async () => {
  const runtime = {
    async status() { return 'running'; },
    async portBinding() { return { published: true, hostPort: 25570, hostIp: '0.0.0.0', allInterfaces: true }; },
    async logs() { return ''; }
  };
  const networkInterfaces = () => ({
    eth0: [{ family: 'IPv4', internal: false, address: '172.18.0.2' }],
    vnic: [{ family: 'IPv4', internal: false, address: '10.0.0.82' }]
  });
  const network = new NetworkService({ runtime, mode: 'cloud', networkInterfaces, publicIpResolver: async () => '203.0.113.8', tcpProbe: async (host) => host !== '203.0.113.8' });
  const result = await network.check({ id: 'cloud-server', port: 25570 });
  assert.equal(result.mode, 'cloud');
  assert.equal(result.lan.ip, '10.0.0.82');
  assert.equal(result.forwarding, null);
  assert.deepEqual(result.cloud, { privateIp: '10.0.0.82', inboundPort: 25570, protocol: 'TCP' });
  assert.equal(result.public.externallyConfirmed, false);
  assert.equal(result.statuses.find((item) => item.id === 'lan').label, 'Private address reachable');
});

test('reports unavailable public detection and an unpublished stopped server conservatively', async () => {
  const runtime = {
    async status() { return 'exited'; },
    async portBinding() { return { published: false, hostPort: null, hostIp: null, allInterfaces: false }; },
    async logs() { return ''; }
  };
  const network = new NetworkService({ runtime, networkInterfaces: () => ({}), publicIpResolver: async () => { throw new Error('offline'); }, tcpProbe: async () => { throw new Error('must not probe'); } });
  const result = await network.check({ id: 'stopped', port: 25565 });
  assert.equal(result.runningLocally, false);
  assert.equal(result.lan.state, 'unavailable');
  assert.equal(result.public.state, 'unavailable');
  assert.equal(result.public.portState, 'not-confirmed');
});

test('uses a configured public hostname for the join address while retaining detected WAN IP', async () => {
  const runtime = {
    async status() { return 'running'; },
    async portBinding() { return { published: true, hostPort: 25565, hostIp: '0.0.0.0', allInterfaces: true }; },
    async logs() { return ''; }
  };
  const probes = [];
  const network = new NetworkService({ runtime, lanIp: '192.168.1.2', publicIpResolver: async () => '198.51.100.44', tcpProbe: async (host) => { probes.push(host); return true; } });
  const result = await network.check({ id: 'dns-server', port: 25565 }, { publicHost: 'mc.example.com' });
  assert.equal(result.public.joinAddress, 'mc.example.com:25565');
  assert.equal(result.public.detectedJoinAddress, '198.51.100.44:25565');
  assert.ok(probes.includes('mc.example.com'));
});
