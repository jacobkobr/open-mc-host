const dns = require('node:dns');
const net = require('node:net');
const os = require('node:os');

class NetworkService {
  constructor({ runtime, lanIp = '', mode = 'auto', networkInterfaces = os.networkInterfaces, publicIpResolver = resolvePublicIp, tcpProbe = probeTcp } = {}) {
    this.runtime = runtime;
    this.lanIp = lanIp;
    this.mode = ['auto', 'home', 'cloud'].includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'auto';
    this.networkInterfaces = networkInterfaces;
    this.publicIpResolver = publicIpResolver;
    this.tcpProbe = tcpProbe;
  }

  async check(server, { publicHost = '' } = {}) {
    const [runtimeStatus, binding, lan, publicIp, logs] = await Promise.all([
      this.runtime.status(server),
      this.runtime.portBinding(server),
      this.detectLanIp(),
      this.publicIpResolver().catch(() => null),
      this.runtime.logs(server, 500).catch(() => '')
    ]);
    const runningLocally = runtimeStatus === 'running';
    const hostProbe = runningLocally && binding.published ? await this.probeHostPort(binding.hostPort).catch(() => false) : false;
    const publicTarget = publicHost || publicIp;
    const publicProbe = runningLocally && binding.published && publicTarget
      ? await this.tcpProbe(publicTarget.replace(/^\[|\]$/g, ''), binding.hostPort).catch(() => false)
      : false;
    const externalConnectionObserved = hasExternalPlayerConnection(logs);
    const publicPortState = externalConnectionObserved ? 'publicly-reachable' : 'not-confirmed';
    const localAddress = lan ? `${lan}:${binding.hostPort || server.port}` : null;
    const publicAddress = publicTarget ? `${formatAddress(publicTarget)}:${binding.hostPort || server.port}` : null;
    const detectedPublicAddress = publicIp ? `${formatAddress(publicIp)}:${binding.hostPort || server.port}` : null;
    return {
      serverId: server.id,
      checkedAt: new Date().toISOString(),
      mode: this.mode,
      runningLocally,
      lan: { ip: lan, joinAddress: localAddress, state: lan ? (hostProbe ? 'reachable' : 'published') : 'unavailable' },
      public: { ip: publicIp, host: publicTarget || null, joinAddress: publicAddress, detectedJoinAddress: detectedPublicAddress, state: publicIp ? 'detected' : publicHost ? 'configured' : 'unavailable', portState: publicPortState, probeFromHost: publicProbe, externallyConfirmed: externalConnectionObserved },
      port: { external: binding.hostPort || server.port, internal: binding.hostPort || server.port, container: 25565, protocol: 'TCP', publishedOnAllInterfaces: binding.allInterfaces },
      forwarding: this.mode === 'cloud' ? null : { internalIp: lan, internalPort: binding.hostPort || server.port, externalPort: binding.hostPort || server.port, protocol: 'TCP' },
      cloud: this.mode === 'cloud' ? { privateIp: lan, inboundPort: binding.hostPort || server.port, protocol: 'TCP' } : null,
      statuses: buildStatuses({ runningLocally, lan, hostProbe, publicIp, publicProbe, externalConnectionObserved, binding, mode: this.mode })
    };
  }

  async detectLanIp() {
    if (isPrivateIpv4(this.lanIp)) return this.lanIp;
    const interfaces = this.networkInterfaces();
    const candidates = Object.values(interfaces).flat().filter((item) => item && item.family === 'IPv4' && !item.internal && isPrivateIpv4(item.address));
    const preferred = candidates.find((item) => !item.address.startsWith('172.')) || candidates[0];
    return preferred?.address || null;
  }

  async probeHostPort(port) {
    const hosts = ['host.docker.internal', '127.0.0.1'];
    for (const host of hosts) {
      if (await this.tcpProbe(host, port)) return true;
    }
    return false;
  }
}

function resolvePublicIp() {
  return new Promise((resolve, reject) => {
    const resolver = new dns.Resolver();
    resolver.setServers(['208.67.222.222', '208.67.220.220']);
    resolver.resolve4('myip.opendns.com', (error, addresses) => error || !addresses.length ? reject(error || new Error('No public IP address returned.')) : resolve(addresses[0]));
  });
}

function probeTcp(host, port, timeout = 1800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const complete = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeout, () => complete(false));
    socket.once('connect', () => complete(true));
    socket.once('error', () => complete(false));
  });
}

function hasExternalPlayerConnection(logs) {
  return [...String(logs).matchAll(/\[\/?((?:\d{1,3}\.){3}\d{1,3}):\d+\]\s+logged in/gi)]
    .some((match) => !isPrivateIpv4(match[1]));
}

function buildStatuses({ runningLocally, lan, hostProbe, publicIp, publicProbe, externalConnectionObserved, binding, mode }) {
  return [
    { id: 'local', label: runningLocally ? 'Running locally' : 'Not running locally', state: runningLocally ? 'success' : 'neutral' },
    { id: 'lan', label: lan && binding.allInterfaces && hostProbe ? (mode === 'cloud' ? 'Private address reachable' : 'LAN reachable') : lan && binding.allInterfaces ? (mode === 'cloud' ? 'Private port published' : 'LAN port published') : (mode === 'cloud' ? 'Private reachability not confirmed' : 'LAN reachability not confirmed'), state: lan && binding.allInterfaces && hostProbe ? 'success' : 'neutral' },
    { id: 'public-ip', label: publicIp ? 'Public IP detected' : 'Public IP unavailable', state: publicIp ? 'success' : 'neutral' },
    { id: 'public-port', label: externalConnectionObserved ? 'Publicly reachable' : publicProbe ? 'Public route answers from host' : 'Public port not confirmed', state: externalConnectionObserved ? 'success' : 'neutral' }
  ];
}

function isPrivateIpv4(value) {
  const parts = String(value || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function formatAddress(value) { return value.includes(':') ? `[${value}]` : value; }

module.exports = { NetworkService, hasExternalPlayerConnection, isPrivateIpv4, resolvePublicIp };
