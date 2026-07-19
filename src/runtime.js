const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AppError } = require('./errors');

function run(command, args, { maxOutputBytes = 10 * 1024 * 1024, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let outputLimitReached = false;
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputLimitReached = true;
        child.kill();
        return;
      }
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', (error) => reject(new AppError(`${command} is unavailable: ${error.message}`, 503)));
    child.on('close', (code) => {
      if (outputLimitReached) return reject(new AppError('Command output exceeded the 10 MB safety limit. Use search or a recent log view.', 413));
      if (code === 0) return resolve(stdout.trim());
      reject(new AppError(stderr.trim() || `${command} exited with code ${code}.`, 502));
    });
  });
}

class DockerRuntime {
  constructor({ dataDir, dockerDataDir, image, host = '127.0.0.1', port = 3000, portRange = '25565-25575', runner = run }) {
    this.dataDir = dataDir;
    this.dockerDataDir = dockerDataDir;
    this.image = image;
    this.panelHost = host;
    this.panelPort = port;
    this.portRange = portRange;
    this.run = runner;
  }

  serverDir(server) {
    return path.join(this.dataDir, 'servers', server.id);
  }

  dockerServerDir(server) {
    return path.join(this.dockerDataDir, 'servers', server.id);
  }

  async create(server) {
    const dataDir = this.serverDir(server);
    await fs.mkdir(dataDir, { recursive: true });
    const args = [
      'run', '-d', '--name', server.containerName, '--restart', 'unless-stopped',
      '--cpus', String(server.cpus || 1),
      '--memory', server.memoryLimit || dockerMemoryLimit(server.memory),
      '--pids-limit', '512',
      '--security-opt', 'no-new-privileges:true',
      '-p', `0.0.0.0:${server.port}:25565`,
      '-v', `${this.dockerServerDir(server)}:/data`,
      '-e', 'EULA=TRUE',
      '-e', `TYPE=${server.software}`,
      '-e', `VERSION=${server.version}`,
      '-e', `MEMORY=${server.memory}`,
      '-e', `SERVER_NAME=${server.name}`,
      '-e', 'ENABLE_RCON=TRUE',
      '-e', `RCON_PASSWORD=${server.rconPassword}`,
      this.runtimeImage(server)
    ];
    if (server.build && server.software === 'PAPER') args.splice(-1, 0, '-e', `PAPER_BUILD=${server.build}`);
    if (server.build && server.software === 'PURPUR') args.splice(-1, 0, '-e', `PURPUR_BUILD=${server.build}`);
    await this.run('docker', args);
  }

  async start(server) { await this.run('docker', ['start', server.containerName]); }
  async stop(server) { await this.run('docker', ['stop', '--time', '30', server.containerName]); }
  async restart(server) { await this.run('docker', ['restart', '--time', '30', server.containerName]); }
  async remove(server) {
    try {
      await this.run('docker', ['rm', '--force', server.containerName]);
    } catch (error) {
      if (!/no such (object|container)/i.test(error.message)) throw error;
    }
  }

  async status(server) {
    try {
      const output = await this.run('docker', ['inspect', '--format', '{{.State.Status}}', server.containerName]);
      return output || 'unknown';
    } catch (error) {
      if (/no such (object|container)/i.test(error.message)) return 'missing';
      throw error;
    }
  }

  async startedAt(server) {
    try {
      const startedAt = await this.run('docker', ['inspect', '--format', '{{.State.StartedAt}}', server.containerName]);
      return startedAt || null;
    } catch (error) {
      if (/no such (object|container)/i.test(error.message)) return null;
      throw error;
    }
  }

  async logs(server, tail = 200, { since = null, until = null } = {}) {
    try {
      const args = ['logs', '--timestamps'];
      if (since) args.push('--since', since);
      if (until) args.push('--until', until);
      if (tail !== 'all') args.push('--tail', String(tail));
      args.push(server.containerName);
      return await this.run('docker', args);
    } catch (error) {
      if (/no such (object|container)/i.test(error.message)) return 'Runtime container is missing. Use Repair runtime to recreate it without deleting server files.';
      throw error;
    }
  }

  async metrics(server) {
    const output = await this.run('docker', ['stats', '--no-stream', '--format', '{{json .}}', server.containerName]);
    const metrics = JSON.parse(output);
    const [startedAt, playerOutput] = await Promise.all([
      this.run('docker', ['inspect', '--format', '{{.State.StartedAt}}', server.containerName]).catch(() => ''),
      this.run('docker', ['exec', server.containerName, 'rcon-cli', 'list']).catch(() => '')
    ]);
    return { ...metrics, ...parsePlayerList(playerOutput), startedAt: startedAt || null, uptimeSeconds: calculateUptime(startedAt) };
  }

  async portBinding(server) {
    const output = await this.run('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', server.containerName]);
    const ports = JSON.parse(output || '{}');
    const bindings = ports['25565/tcp'] || [];
    const binding = bindings.find((item) => Number(item.HostPort) === server.port) || bindings[0];
    if (!binding) return { published: false, hostPort: null, hostIp: null, allInterfaces: false };
    return { published: true, hostPort: Number(binding.HostPort), hostIp: binding.HostIp, allInterfaces: binding.HostIp === '0.0.0.0' || binding.HostIp === '::' };
  }

  async command(server, command) {
    if (!command || command.length > 500) throw new AppError('Command must be between 1 and 500 characters.');
    await this.run('docker', ['exec', server.containerName, 'rcon-cli', command]);
  }

  async backup(server, backupPath) {
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await this.run('tar', ['-czf', backupPath, '-C', this.serverDir(server), '.']);
  }

  async validateBackup(backupPath) {
    const entries = (await this.run('tar', ['-tzf', backupPath])).split('\n').map((entry) => entry.trim()).filter(Boolean);
    if (!entries.length) throw new AppError('The backup archive is empty.', 400);
    if (entries.length > 100_000) throw new AppError('The backup archive contains too many entries.', 413);
    for (const entry of entries) {
      const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '');
      if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) throw new AppError('The backup archive contains an unsafe path.', 400);
    }
    const details = (await this.run('tar', ['-tvzf', backupPath])).split('\n').filter(Boolean);
    if (details.some((line) => !['-', 'd'].includes(line[0]))) throw new AppError('The backup archive contains unsupported link or device entries.', 400);
    return { entries: entries.length };
  }

  async restore(server, backupPath) {
    const dataDir = this.serverDir(server);
    await this.validateBackup(backupPath);
    await fs.mkdir(dataDir, { recursive: true });
    await this.run('tar', ['-xzf', backupPath, '-C', dataDir]);
  }

  async nodeStatus() {
    const output = await this.run('docker', ['info', '--format', '{{json .}}']);
    const info = JSON.parse(output);
    return { runtime: 'docker', containers: info.Containers, images: info.Images, driver: info.Driver, operatingSystem: info.OperatingSystem, gamePortRange: this.portRange, panel: await this.panelBinding() };
  }

  async panelBinding() {
    const fallback = { applicationHost: this.panelHost, applicationPort: this.panelPort, published: null, loopbackOnly: null, exposure: 'unknown', bindings: [] };
    const containerId = String(process.env.HOSTNAME || '').trim();
    if (!containerId) return fallback;
    try {
      const output = await this.run('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', containerId]);
      return { applicationHost: this.panelHost, applicationPort: this.panelPort, ...parsePanelBindings(JSON.parse(output || '{}'), this.panelPort) };
    } catch {
      return fallback;
    }
  }

  runtimeImage(server) {
    if (!/:java\d+(?:$|[-@])/i.test(this.image)) return this.image;
    return this.image.replace(/:java\d+/i, `:java${javaMajorForMinecraft(server.version)}`);
  }
}

function dockerMemoryLimit(memory) {
  const match = String(memory || '2G').match(/^(\d+)(M|G)$/i);
  if (!match) return '3G';
  const megabytes = Number(match[1]) * (match[2].toUpperCase() === 'G' ? 1024 : 1);
  return `${Math.max(megabytes + 768, Math.ceil(megabytes * 1.25))}M`;
}

function javaMajorForMinecraft(version) {
  const parts = String(version || '').split('.').map(Number);
  if (parts[0] >= 26) return 25;
  if (parts[0] === 1 && (parts[1] > 20 || parts[1] === 20 && (parts[2] || 0) >= 5)) return 21;
  if (parts[0] === 1 && parts[1] >= 17) return 17;
  return 8;
}

function parsePlayerList(output) {
  const match = String(output || '').match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online:?\s*(.*)$/i);
  if (!match) return { playersOnline: null, maxPlayers: null, players: [] };
  return { playersOnline: Number(match[1]), maxPlayers: Number(match[2]), players: match[3].split(',').map((name) => name.trim()).filter(Boolean) };
}

function parsePanelBindings(ports, panelPort) {
  const bindings = Array.isArray(ports?.[`${panelPort}/tcp`]) ? ports[`${panelPort}/tcp`].map((binding) => ({ hostIp: binding.HostIp, hostPort: Number(binding.HostPort) })) : [];
  if (!bindings.length) return { published: false, loopbackOnly: null, exposure: 'unpublished', bindings };
  const loopbackOnly = bindings.every((binding) => ['127.0.0.1', '::1'].includes(binding.hostIp));
  return { published: true, loopbackOnly, exposure: loopbackOnly ? 'loopback-only' : 'public-or-network', bindings };
}

function calculateUptime(startedAt, now = Date.now()) {
  const started = Date.parse(String(startedAt || ''));
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : null;
}

module.exports = { DockerRuntime, run, dockerMemoryLimit, javaMajorForMinecraft, parsePlayerList, parsePanelBindings, calculateUptime };
