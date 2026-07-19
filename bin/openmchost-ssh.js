#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout, stderr } = require('node:process');
const { AccessService } = require('../src/access');
const { AppError } = require('../src/errors');

const SOFTWARE = new Set(['VANILLA', 'PAPER', 'PURPUR', 'FABRIC', 'FORGE', 'NEOFORGE']);
const SAFE_HELP = [
  'help',
  'whoami',
  'quota',
  'servers',
  'status <server-id>',
  'start <server-id>',
  'stop <server-id>',
  'restart <server-id>',
  'create <short-name> [software] [version] [memory]'
];

function validateServerId(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value || '')) throw new AppError('Server ID is invalid.');
  return value;
}

function createInput(parts) {
  const name = String(parts[1] || '').trim();
  const software = String(parts[2] || 'PAPER').toUpperCase();
  const version = String(parts[3] || 'LATEST');
  const memory = String(parts[4] || '2G').toUpperCase();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(name)) throw new AppError('Use a 3-32 character short server name without spaces.');
  if (!SOFTWARE.has(software)) throw new AppError(`Software must be one of: ${[...SOFTWARE].join(', ')}.`);
  if (!/^[a-zA-Z0-9._-]{1,32}$/.test(version)) throw new AppError('Minecraft version is invalid.');
  if (!/^\d+(M|G)$/.test(memory)) throw new AppError('Memory must look like 2G or 4096M.');
  return { name, software, version, memory };
}

function parseCommand(input) {
  const command = String(input || '').trim();
  if (!command) return { kind: 'interactive' };
  if (command.length > 256 || /[;&|`$<>\r\n\\"']/.test(command)) throw new AppError('That SSH command is not allowed.', 403);
  const parts = command.split(/\s+/);
  const verb = parts[0].toLowerCase();
  if (verb === 'help' && parts.length === 1) return { kind: 'local', action: 'help' };
  if (verb === 'whoami' && parts.length === 1) return { kind: 'local', action: 'whoami' };
  if (verb === 'quota' && parts.length === 1) return { kind: 'local', action: 'quota' };
  if ((verb === 'servers' || verb === 'list') && parts.length === 1) return { kind: 'remote', action: 'servers.list', args: {} };
  if (verb === 'status' && parts.length === 2) return { kind: 'remote', action: 'servers.status', args: { serverId: validateServerId(parts[1]) } };
  if (['start', 'stop', 'restart'].includes(verb) && parts.length === 2) {
    return { kind: 'remote', action: `servers.${verb}`, args: { serverId: validateServerId(parts[1]) } };
  }
  if (verb === 'create' && parts.length >= 2 && parts.length <= 5) return { kind: 'remote', action: 'servers.create', args: createInput(parts) };
  throw new AppError('That SSH command is not allowed. Run "help" for the safe command list.', 403);
}

function assertLoopbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('SSH gateway URL is invalid.', 500); }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (!loopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError('SSH gateway must use a loopback HTTP URL.', 500);
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

class RestrictedGatewayClient {
  constructor({ baseUrl = 'http://127.0.0.1:3000/api/v1/ssh', tokenFile, fetchImpl = globalThis.fetch }) {
    this.baseUrl = assertLoopbackUrl(baseUrl);
    this.tokenFile = tokenFile;
    this.fetchImpl = fetchImpl;
  }

  async execute(principalId, action, args = {}) {
    if (!/^servers\.(list|status|start|stop|restart|create)$/.test(action)) throw new AppError('SSH action is not allowed.', 403);
    if (!this.tokenFile) throw new AppError('SSH gateway authentication is not configured.', 503);
    const token = (await fs.readFile(this.tokenFile, 'utf8')).trim();
    if (token.length < 24) throw new AppError('SSH gateway authentication is not configured.', 503);
    const response = await this.fetchImpl(`${this.baseUrl}/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ principalId, action, args })
    });
    let payload;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) throw new AppError(payload.error || `Dashboard returned HTTP ${response.status}.`, response.status);
    return payload;
  }
}

function formatResult(value) {
  if (Array.isArray(value)) {
    if (!value.length) return 'No servers yet.';
    return value.map((item) => `${item.name || item.id || item.serverId}\t${item.status || ''}\t${item.connectionAddress || ''}`.trim()).join('\n');
  }
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value ?? 'Done.');
}

async function authorizeRemote(access, principal, parsed) {
  if (parsed.action === 'servers.create') {
    await access.assertAuthorized(principal, 'server.create');
    const memory = parsed.args.memory.endsWith('G') ? Number(parsed.args.memory.slice(0, -1)) * 1024 : Number(parsed.args.memory.slice(0, -1));
    const quota = await access.checkQuota(principal.id, { servers: 1, memoryMiB: memory });
    if (!quota.allowed) throw new AppError(`Account quota exceeded: ${quota.exceeded.join(', ')}.`, 409);
    return;
  }
  if (parsed.action === 'servers.list') return;
  const permission = parsed.action === 'servers.status' ? 'server.read' : 'server.control';
  await access.assertAuthorized(principal, permission, parsed.args.serverId);
}

async function runCommand(parsed, { access, client, principalId }) {
  const principal = await access.getPrincipal(principalId);
  if (parsed.kind === 'local' && parsed.action === 'help') return `Open MC Host safe SSH commands:\n\n${SAFE_HELP.map((line) => `  ${line}`).join('\n')}\n\nThis account cannot open a shell, run Docker, use sudo, or forward ports.`;
  if (parsed.kind === 'local' && parsed.action === 'whoami') return `${principal.displayName} (@${principal.username})\nRole: ${principal.role}`;
  if (parsed.kind === 'local' && parsed.action === 'quota') return formatResult(await access.checkQuota(principal.id));
  if (parsed.kind !== 'remote') throw new AppError('Interactive command required.');
  await authorizeRemote(access, principal, parsed);
  return formatResult(await client.execute(principal.id, parsed.action, parsed.args));
}

async function askServerId(prompt, rl) {
  return validateServerId((await rl.question(prompt)).trim());
}

async function interactive({ access, client, principalId, input = stdin, output = stdout }) {
  const rl = readline.createInterface({ input, output, terminal: Boolean(output.isTTY) });
  try {
    const principal = await access.getPrincipal(principalId);
    output.write(`\nOpen MC Host\nWelcome, ${principal.displayName}. Choose an action:\n`);
    while (true) {
      output.write('\n  1. Show my servers\n  2. Create a server\n  3. Start a server\n  4. Stop a server\n  5. Restart a server\n  6. Show my quota\n  7. Exit\n\n');
      const choice = (await rl.question('Choice: ')).trim();
      let parsed;
      if (choice === '1') parsed = parseCommand('servers');
      else if (choice === '2') {
        const name = (await rl.question('Short server name (no spaces): ')).trim();
        const software = (await rl.question('Software [PAPER]: ')).trim() || 'PAPER';
        const version = (await rl.question('Minecraft version [LATEST]: ')).trim() || 'LATEST';
        const memory = (await rl.question('Memory [2G]: ')).trim() || '2G';
        parsed = { kind: 'remote', action: 'servers.create', args: createInput(['create', name, software, version, memory]) };
      } else if (choice === '3') parsed = { kind: 'remote', action: 'servers.start', args: { serverId: await askServerId('Server ID: ', rl) } };
      else if (choice === '4') parsed = { kind: 'remote', action: 'servers.stop', args: { serverId: await askServerId('Server ID: ', rl) } };
      else if (choice === '5') parsed = { kind: 'remote', action: 'servers.restart', args: { serverId: await askServerId('Server ID: ', rl) } };
      else if (choice === '6') parsed = { kind: 'local', action: 'quota' };
      else if (choice === '7' || choice.toLowerCase() === 'exit') return;
      else {
        output.write('Please enter a number from 1 to 7.\n');
        continue;
      }
      try { output.write(`\n${await runCommand(parsed, { access, client, principalId })}\n`); }
      catch (error) { output.write(`\nCould not complete that action: ${error.message}\n`); }
    }
  } finally {
    rl.close();
  }
}

function parseArguments(argv) {
  const options = { dataDir: process.env.MC_HOST_DATA_DIR || path.resolve(process.cwd(), '.data'), principalId: '', renderAuthorizedKeys: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--data-dir') options.dataDir = path.resolve(argv[++index] || '');
    else if (argument === '--principal') options.principalId = argv[++index] || '';
    else if (argument === '--render-authorized-keys') options.renderAuthorizedKeys = true;
    else throw new AppError(`Unknown gateway option: ${argument}`, 403);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const access = new AccessService({ dataDir: options.dataDir });
  if (options.renderAuthorizedKeys) {
    if (process.env.SSH_CONNECTION || (typeof process.getuid === 'function' && process.getuid() !== 0)) throw new AppError('Authorized-key export requires local root access.', 403);
    stdout.write(await access.renderAuthorizedKeys({ command: process.env.MC_HOST_SSH_COMMAND || '/usr/local/bin/openmchost-ssh', dataDir: options.dataDir }));
    return;
  }
  if (!options.principalId) throw new AppError('This SSH key is not linked to an Open MC Host account.', 403);
  const client = new RestrictedGatewayClient({
    baseUrl: process.env.MC_HOST_SSH_GATEWAY_URL || 'http://127.0.0.1:3000/api/v1/ssh',
    tokenFile: process.env.MC_HOST_SSH_GATEWAY_TOKEN_FILE || path.join(options.dataDir, 'ssh-gateway-token')
  });
  const original = process.env.SSH_ORIGINAL_COMMAND || '';
  const parsed = parseCommand(original);
  if (parsed.kind === 'interactive') await interactive({ access, client, principalId: options.principalId });
  else stdout.write(`${await runCommand(parsed, { access, client, principalId: options.principalId })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    stderr.write(`Open MC Host: ${error.message}\n`);
    process.exitCode = error.status === 403 ? 126 : 1;
  });
}

module.exports = { RestrictedGatewayClient, SAFE_HELP, assertLoopbackUrl, authorizeRemote, createInput, interactive, parseCommand, runCommand };
