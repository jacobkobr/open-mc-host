const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AppError } = require('./errors');

const ROLES = new Set(['owner', 'member', 'operator', 'viewer']);
const GRANT_LEVELS = new Set(['view', 'operate', 'manage']);
const GRANT_WEIGHT = { view: 1, operate: 2, manage: 3 };
const DEFAULT_QUOTAS = Object.freeze({
  owner: { maxServers: null, maxMemoryMiB: null, maxStorageBytes: null },
  member: { maxServers: 2, maxMemoryMiB: 8192, maxStorageBytes: 25 * 1024 ** 3 },
  operator: { maxServers: 4, maxMemoryMiB: 16384, maxStorageBytes: 50 * 1024 ** 3 },
  viewer: { maxServers: 0, maxMemoryMiB: 0, maxStorageBytes: 0 }
});
const SERVER_ACTION_LEVELS = Object.freeze({
  'server.read': 'view',
  'server.logs': 'view',
  'server.metrics': 'view',
  'server.control': 'operate',
  'server.command': 'operate',
  'server.files': 'manage',
  'server.backup': 'manage'
});
const KNOWN_ACTIONS = new Set([...Object.keys(SERVER_ACTION_LEVELS), 'server.create', 'server.delete', 'server.grant']);
const SSH_KEY_TYPES = new Set(['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']);

function wait(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function copy(value) {
  return structuredClone(value);
}

function cleanText(value, field, minimum, maximum) {
  const text = String(value || '').trim();
  if (text.length < minimum || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new AppError(`${field} must be ${minimum}-${maximum} printable characters.`);
  }
  return text;
}

function cleanUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username)) {
    throw new AppError('Username must be 3-32 lowercase letters, numbers, dots, underscores, or dashes.');
  }
  return username;
}

function cleanRole(value, { allowOwner = true } = {}) {
  const role = String(value || '').toLowerCase();
  if (!ROLES.has(role) || (!allowOwner && role === 'owner')) throw new AppError('Role is invalid.');
  return role;
}

function finiteLimit(value, field) {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new AppError(`${field} must be a non-negative integer or null.`);
  return number;
}

function normalizeQuotas(role, input = {}) {
  const defaults = DEFAULT_QUOTAS[role];
  if (role === 'owner') return { ...defaults };
  return {
    maxServers: finiteLimit(input.maxServers ?? defaults.maxServers, 'maxServers'),
    maxMemoryMiB: finiteLimit(input.maxMemoryMiB ?? defaults.maxMemoryMiB, 'maxMemoryMiB'),
    maxStorageBytes: finiteLimit(input.maxStorageBytes ?? defaults.maxStorageBytes, 'maxStorageBytes')
  };
}

function publicPrincipal(principal) {
  if (!principal) return null;
  const { credentials, ...safe } = principal;
  return { ...copy(safe), credentialCount: credentials.filter((credential) => !credential.revokedAt).length };
}

function publicInvite(invite) {
  const { secretHash, secretSalt, ...safe } = invite;
  return copy(safe);
}

function publicCredential(credential) {
  const { secretHash, secretSalt, ...safe } = credential;
  return copy(safe);
}

function credentialParts(token, prefix) {
  if (typeof token !== 'string') return null;
  const match = token.match(new RegExp(`^${prefix}_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$`));
  return match ? { id: match[1], secret: match[2] } : null;
}

function scrypt(secret, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString('base64url'));
    });
  });
}

async function createSecret(prefix) {
  const id = crypto.randomBytes(12).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  const token = `${prefix}_${id}_${secret}`;
  const secretSalt = crypto.randomBytes(16).toString('base64url');
  return { id, token, secretSalt, secretHash: await scrypt(secret, secretSalt) };
}

async function hashSuppliedCredential(token) {
  if (typeof token !== 'string' || token.length < 24 || token.length > 512) {
    throw new AppError('The bootstrap credential must contain at least 24 characters.');
  }
  const formatted = credentialParts(token, 'omh');
  const id = formatted?.id || crypto.randomBytes(12).toString('base64url');
  const secret = formatted?.secret || token;
  const secretSalt = crypto.randomBytes(16).toString('base64url');
  return { id, secretSalt, secretHash: await scrypt(secret, secretSalt), legacyFormat: !formatted };
}

async function matchesSecret(secret, record) {
  const actual = Buffer.from(await scrypt(secret, record.secretSalt));
  const expected = Buffer.from(record.secretHash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function principalAcceptsToken(principal, token) {
  const formatted = credentialParts(token, 'omh');
  for (const credential of principal.credentials.filter((item) => !item.revokedAt)) {
    if (formatted) {
      if (credential.id === formatted.id && await matchesSecret(formatted.secret, credential)) return true;
    } else if (credential.legacyFormat && await matchesSecret(token, credential)) return true;
  }
  return false;
}

function parseSshPublicKey(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 16384 || /[\r\n]/.test(text)) throw new AppError('SSH public key must be a single line.');
  const parts = text.split(/\s+/);
  if (parts.length < 2 || !SSH_KEY_TYPES.has(parts[0])) throw new AppError('SSH key type is not supported.');
  let bytes;
  try { bytes = Buffer.from(parts[1], 'base64'); } catch { throw new AppError('SSH public key is invalid.'); }
  if (bytes.length < 32 || bytes.toString('base64').replace(/=+$/, '') !== parts[1].replace(/=+$/, '')) {
    throw new AppError('SSH public key is invalid.');
  }
  const comment = parts.slice(2).join(' ').slice(0, 128);
  return {
    publicKey: `${parts[0]} ${parts[1]}${comment ? ` ${comment}` : ''}`,
    fingerprint: `SHA256:${crypto.createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}`
  };
}

function initialState() {
  return { version: 1, principals: [], invites: [], servers: [], grants: [], auditEvents: [] };
}

class AccessService {
  constructor({ dataDir, ownerToken = '', ownerUsername = 'owner', ownerDisplayName = 'Owner', now = () => new Date() }) {
    if (!dataDir) throw new TypeError('dataDir is required');
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'access.json');
    this.lockDirectory = `${this.file}.lock`;
    this.ownerToken = ownerToken;
    this.ownerUsername = ownerUsername;
    this.ownerDisplayName = ownerDisplayName;
    this.now = now;
    this.queue = Promise.resolve();
  }

  timestamp() {
    return this.now().toISOString();
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true });
    return this.mutate(async (state) => {
      const owner = state.principals.find((principal) => principal.role === 'owner' && principal.status === 'active');
      if (owner) {
        let rotated = false;
        if (this.ownerToken && !(await principalAcceptsToken(owner, this.ownerToken))) {
          const replacement = await hashSuppliedCredential(this.ownerToken);
          for (const credential of owner.credentials) {
            if ((credential.environmentManaged || credential.legacyFormat) && !credential.revokedAt) credential.revokedAt = this.timestamp();
          }
          owner.credentials.push({ id: replacement.id, label: 'Environment owner recovery', secretSalt: replacement.secretSalt, secretHash: replacement.secretHash, legacyFormat: replacement.legacyFormat, environmentManaged: true, createdAt: this.timestamp(), lastUsedAt: null, revokedAt: null });
          owner.updatedAt = this.timestamp();
          this.audit(state, owner.id, 'credential.environment_rotated', { principalId: owner.id });
          rotated = true;
        }
        return { created: false, rotated, principal: publicPrincipal(owner), credential: null };
      }
      const principal = this.newPrincipal({ username: this.ownerUsername, displayName: this.ownerDisplayName, role: 'owner', quotas: {} });
      let credential;
      let token = this.ownerToken || '';
      const configuredCredential = Boolean(token);
      if (token) credential = await hashSuppliedCredential(token);
      else {
        const generated = await createSecret('omh');
        token = generated.token;
        credential = generated;
      }
      principal.credentials.push({ id: credential.id, label: 'Owner bootstrap', secretSalt: credential.secretSalt, secretHash: credential.secretHash, legacyFormat: Boolean(credential.legacyFormat), environmentManaged: configuredCredential, createdAt: this.timestamp(), lastUsedAt: null, revokedAt: null });
      state.principals.push(principal);
      this.audit(state, principal.id, 'access.owner_bootstrapped', { principalId: principal.id });
      return { created: true, principal: publicPrincipal(principal), credential: configuredCredential ? null : token };
    });
  }

  newPrincipal({ username, displayName, role, quotas }) {
    const timestamp = this.timestamp();
    return {
      id: crypto.randomUUID(),
      username: cleanUsername(username),
      displayName: cleanText(displayName || username, 'Display name', 2, 64),
      role: cleanRole(role),
      status: 'active',
      quotas: normalizeQuotas(role, quotas),
      credentials: [],
      sshKeys: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      disabledAt: null
    };
  }

  audit(state, actorId, action, details = {}) {
    const event = { id: crypto.randomUUID(), at: this.timestamp(), actorId: actorId || 'system', action, ...copy(details) };
    state.auditEvents.push(event);
    if (state.auditEvents.length > 10000) state.auditEvents.splice(0, state.auditEvents.length - 10000);
    return event;
  }

  async read() {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.principals) || !Array.isArray(state.invites) || !Array.isArray(state.servers) || !Array.isArray(state.grants) || !Array.isArray(state.auditEvents)) {
        throw new Error('Unsupported access store format');
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return initialState();
      throw error;
    }
  }

  async atomicWrite(state) {
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o640);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, this.file);
      await fs.chmod(this.file, 0o640);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  async acquireLock() {
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await fs.mkdir(this.lockDirectory);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const stats = await fs.stat(this.lockDirectory);
          if (Date.now() - stats.mtimeMs > 30000) {
            await fs.rm(this.lockDirectory, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError;
          continue;
        }
        if (Date.now() >= deadline) throw new AppError('Access store is busy. Try again.', 503);
        await wait(20 + Math.floor(Math.random() * 30));
      }
    }
  }

  mutate(operation) {
    const run = this.queue.then(async () => {
      await this.acquireLock();
      try {
        const state = await this.read();
        const result = await operation(state);
        await this.atomicWrite(state);
        return result;
      } finally {
        await fs.rm(this.lockDirectory, { recursive: true, force: true });
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  principalFrom(state, principalOrId, { active = true } = {}) {
    const id = typeof principalOrId === 'string' ? principalOrId : principalOrId?.id;
    const principal = state.principals.find((item) => item.id === id);
    if (!principal || (active && principal.status !== 'active')) throw new AppError('Account not found or disabled.', 403);
    return principal;
  }

  assertOwner(state, actorId) {
    const actor = this.principalFrom(state, actorId);
    if (actor.role !== 'owner') throw new AppError('Owner access is required.', 403);
    return actor;
  }

  async authenticate(token) {
    if (typeof token !== 'string' || token.length < 1 || token.length > 512) return null;
    const formatted = credentialParts(token, 'omh');
    const state = await this.read();
    for (const principal of state.principals) {
      if (principal.status !== 'active') continue;
      const credentials = formatted
        ? principal.credentials.filter((credential) => credential.id === formatted.id && !credential.revokedAt)
        : principal.credentials.filter((credential) => credential.legacyFormat && !credential.revokedAt);
      for (const credential of credentials) {
        const candidate = formatted ? formatted.secret : token;
        if (await matchesSecret(candidate, credential)) return publicPrincipal(principal);
      }
    }
    return null;
  }

  async requireAuthenticated(token) {
    const principal = await this.authenticate(token);
    if (!principal) throw new AppError('A valid bearer credential is required.', 401);
    return principal;
  }

  async getPrincipal(actorId, principalId = actorId) {
    const state = await this.read();
    const actor = this.principalFrom(state, actorId);
    if (actor.id !== principalId && actor.role !== 'owner') throw new AppError('Owner access is required.', 403);
    return publicPrincipal(this.principalFrom(state, principalId, { active: false }));
  }

  async listPrincipals(actorId) {
    const state = await this.read();
    this.assertOwner(state, actorId);
    return state.principals.map((principal) => ({ ...publicPrincipal(principal), quota: this.quotaResult(state, principal) }));
  }

  async listCredentials(actorId, principalId = actorId) {
    const state = await this.read();
    const actor = this.principalFrom(state, actorId);
    if (principalId !== actor.id && actor.role !== 'owner') throw new AppError('Owner access is required.', 403);
    const principal = this.principalFrom(state, principalId, { active: false });
    return principal.credentials.map(publicCredential).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async createCredential(actorId, { principalId = actorId, label = 'Dashboard' } = {}) {
    return this.mutate(async (state) => {
      const actor = this.principalFrom(state, actorId);
      if (principalId !== actor.id && actor.role !== 'owner') throw new AppError('Owner access is required.', 403);
      const principal = this.principalFrom(state, principalId);
      const secret = await createSecret('omh');
      principal.credentials.push({ id: secret.id, label: cleanText(label, 'Credential label', 2, 64), secretSalt: secret.secretSalt, secretHash: secret.secretHash, legacyFormat: false, createdAt: this.timestamp(), lastUsedAt: null, revokedAt: null });
      principal.updatedAt = this.timestamp();
      this.audit(state, actor.id, 'credential.created', { principalId, credentialId: secret.id });
      return { id: secret.id, token: secret.token, label, principalId };
    });
  }

  async revokeCredential(actorId, principalId, credentialId) {
    return this.mutate(async (state) => {
      const actor = this.principalFrom(state, actorId);
      if (principalId !== actor.id && actor.role !== 'owner') throw new AppError('Owner access is required.', 403);
      const principal = this.principalFrom(state, principalId);
      const credential = principal.credentials.find((item) => item.id === credentialId && !item.revokedAt);
      if (!credential) throw new AppError('Credential not found.', 404);
      if (principal.role === 'owner' && principal.credentials.filter((item) => !item.revokedAt).length === 1) throw new AppError('The owner must retain at least one credential.');
      credential.revokedAt = this.timestamp();
      principal.updatedAt = this.timestamp();
      this.audit(state, actor.id, 'credential.revoked', { principalId, credentialId });
    });
  }

  async restoreCredential(actorId, principalId, credentialId) {
    return this.mutate(async (state) => {
      const actor = this.principalFrom(state, actorId);
      if (principalId !== actor.id && actor.role !== 'owner') throw new AppError('Owner access is required.', 403);
      const principal = this.principalFrom(state, principalId, { active: false });
      const credential = principal.credentials.find((item) => item.id === credentialId && item.revokedAt);
      if (!credential) throw new AppError('Revoked credential not found.', 404);
      credential.revokedAt = null;
      principal.updatedAt = this.timestamp();
      this.audit(state, actor.id, 'credential.restored', { principalId, credentialId });
      return publicCredential(credential);
    });
  }

  async deleteCredential(actorId, principalId, credentialId) {
    return this.mutate(async (state) => {
      const actor = this.principalFrom(state, actorId);
      if (principalId !== actor.id && actor.role !== 'owner') throw new AppError('Owner access is required.', 403);
      const principal = this.principalFrom(state, principalId, { active: false });
      const credential = principal.credentials.find((item) => item.id === credentialId);
      if (!credential) throw new AppError('Credential not found.', 404);
      if (principal.role === 'owner' && !credential.revokedAt && principal.credentials.filter((item) => !item.revokedAt).length === 1) throw new AppError('The owner must retain at least one credential.');
      principal.credentials = principal.credentials.filter((item) => item.id !== credentialId);
      principal.updatedAt = this.timestamp();
      this.audit(state, actor.id, 'credential.deleted', { principalId, credentialId });
    });
  }

  async createInvite(actorId, { role = 'member', quotas = {}, expiresInHours = 48 } = {}) {
    return this.mutate(async (state) => {
      const actor = this.assertOwner(state, actorId);
      role = cleanRole(role, { allowOwner: false });
      const hours = Number(expiresInHours);
      if (!Number.isFinite(hours) || hours < 1 || hours > 720) throw new AppError('Invite expiry must be between 1 and 720 hours.');
      const secret = await createSecret('omhi');
      const invite = {
        id: secret.id,
        role,
        quotas: normalizeQuotas(role, quotas),
        secretSalt: secret.secretSalt,
        secretHash: secret.secretHash,
        createdBy: actor.id,
        createdAt: this.timestamp(),
        expiresAt: new Date(this.now().getTime() + hours * 60 * 60 * 1000).toISOString(),
        claimedAt: null,
        claimedBy: null,
        revokedAt: null
      };
      state.invites.push(invite);
      this.audit(state, actor.id, 'invite.created', { inviteId: invite.id, role });
      return { ...publicInvite(invite), code: secret.token };
    });
  }

  async listInvites(actorId) {
    const state = await this.read();
    this.assertOwner(state, actorId);
    return state.invites.map(publicInvite);
  }

  async revokeInvite(actorId, inviteId) {
    return this.mutate(async (state) => {
      const actor = this.assertOwner(state, actorId);
      const invite = state.invites.find((item) => item.id === inviteId && !item.revokedAt && !item.claimedAt);
      if (!invite) throw new AppError('Active invite not found.', 404);
      invite.revokedAt = this.timestamp();
      this.audit(state, actor.id, 'invite.revoked', { inviteId });
    });
  }

  async redeemInvite(code, { username, displayName, credentialLabel = 'Dashboard' }) {
    const formatted = credentialParts(code, 'omhi');
    if (!formatted) throw new AppError('Invite code is invalid.', 401);
    return this.mutate(async (state) => {
      const invite = state.invites.find((item) => item.id === formatted.id && !item.claimedAt && !item.revokedAt);
      if (!invite || new Date(invite.expiresAt).getTime() <= this.now().getTime() || !(await matchesSecret(formatted.secret, invite))) {
        throw new AppError('Invite code is invalid or expired.', 401);
      }
      username = cleanUsername(username);
      if (state.principals.some((principal) => principal.username === username)) throw new AppError('That username is already in use.', 409);
      const principal = this.newPrincipal({ username, displayName: displayName || username, role: invite.role, quotas: invite.quotas });
      const credential = await createSecret('omh');
      principal.credentials.push({ id: credential.id, label: cleanText(credentialLabel, 'Credential label', 2, 64), secretSalt: credential.secretSalt, secretHash: credential.secretHash, legacyFormat: false, createdAt: this.timestamp(), lastUsedAt: null, revokedAt: null });
      state.principals.push(principal);
      invite.claimedAt = this.timestamp();
      invite.claimedBy = principal.id;
      this.audit(state, principal.id, 'invite.claimed', { inviteId: invite.id, principalId: principal.id });
      return { principal: publicPrincipal(principal), credential: credential.token };
    });
  }

  async updatePrincipal(actorId, principalId, changes = {}) {
    return this.mutate(async (state) => {
      const actor = this.assertOwner(state, actorId);
      const principal = this.principalFrom(state, principalId, { active: false });
      if (principal.role === 'owner' && (changes.role || changes.status === 'disabled')) throw new AppError('The bootstrap owner cannot be demoted or disabled.');
      if (changes.displayName !== undefined) principal.displayName = cleanText(changes.displayName, 'Display name', 2, 64);
      if (changes.role !== undefined) {
        principal.role = cleanRole(changes.role, { allowOwner: false });
        principal.quotas = normalizeQuotas(principal.role, changes.quotas || principal.quotas);
      } else if (changes.quotas !== undefined) principal.quotas = normalizeQuotas(principal.role, changes.quotas);
      if (changes.status !== undefined) {
        if (!['active', 'disabled'].includes(changes.status)) throw new AppError('Account status is invalid.');
        principal.status = changes.status;
        principal.disabledAt = changes.status === 'disabled' ? this.timestamp() : null;
      }
      principal.updatedAt = this.timestamp();
      this.audit(state, actor.id, 'principal.updated', { principalId, status: principal.status, role: principal.role });
      return publicPrincipal(principal);
    });
  }

  quotaUsage(state, principalId) {
    const servers = state.servers.filter((server) => server.ownerId === principalId);
    return {
      servers: servers.length,
      memoryMiB: servers.reduce((total, server) => total + server.memoryMiB, 0),
      storageBytes: servers.reduce((total, server) => total + server.storageBytes, 0)
    };
  }

  quotaResult(state, principal, requested = {}) {
    const usage = this.quotaUsage(state, principal.id);
    const next = {
      servers: usage.servers + Number(requested.servers || 0),
      memoryMiB: usage.memoryMiB + Number(requested.memoryMiB || 0),
      storageBytes: usage.storageBytes + Number(requested.storageBytes || 0)
    };
    const limits = principal.quotas;
    const exceeded = [];
    if (limits.maxServers !== null && next.servers > limits.maxServers) exceeded.push('servers');
    if (limits.maxMemoryMiB !== null && next.memoryMiB > limits.maxMemoryMiB) exceeded.push('memory');
    if (limits.maxStorageBytes !== null && next.storageBytes > limits.maxStorageBytes) exceeded.push('storage');
    return { usage, requested: copy(requested), projected: next, limits: copy(limits), allowed: exceeded.length === 0, exceeded };
  }

  async checkQuota(principalId, requested = {}) {
    const state = await this.read();
    const principal = this.principalFrom(state, principalId);
    return this.quotaResult(state, principal, requested);
  }

  async registerServer(actorId, { serverId, ownerId = actorId, memoryMiB = 0, storageBytes = 0 }) {
    return this.mutate(async (state) => {
      const actor = this.principalFrom(state, actorId);
      const owner = this.principalFrom(state, ownerId);
      if (actor.id !== owner.id && actor.role !== 'owner') throw new AppError('Owner access is required to assign another account.', 403);
      if (owner.role === 'viewer') throw new AppError('Viewer accounts cannot own servers.', 403);
      serverId = cleanText(serverId, 'Server ID', 1, 128);
      if (state.servers.some((server) => server.serverId === serverId)) throw new AppError('Server access record already exists.', 409);
      memoryMiB = finiteLimit(memoryMiB, 'memoryMiB');
      storageBytes = finiteLimit(storageBytes, 'storageBytes');
      const quota = this.quotaResult(state, owner, { servers: 1, memoryMiB, storageBytes });
      if (!quota.allowed) throw new AppError(`Account quota exceeded: ${quota.exceeded.join(', ')}.`, 409);
      const record = { serverId, ownerId: owner.id, memoryMiB, storageBytes, createdAt: this.timestamp(), updatedAt: this.timestamp() };
      state.servers.push(record);
      this.audit(state, actor.id, 'server.registered', { serverId, ownerId: owner.id });
      return copy(record);
    });
  }

  async unregisterServer(actorId, serverId) {
    return this.mutate(async (state) => {
      this.assertServerOwner(state, actorId, serverId);
      state.servers = state.servers.filter((server) => server.serverId !== serverId);
      state.grants = state.grants.filter((grant) => grant.serverId !== serverId);
      this.audit(state, actorId, 'server.unregistered', { serverId });
    });
  }

  assertServerOwner(state, actorId, serverId) {
    const actor = this.principalFrom(state, actorId);
    const server = state.servers.find((item) => item.serverId === serverId);
    if (!server) throw new AppError('Server access record not found.', 404);
    if (actor.role !== 'owner' && server.ownerId !== actor.id) throw new AppError('Server owner access is required.', 403);
    return { actor, server };
  }

  async grantServer(actorId, { serverId, principalId, level = 'view' }) {
    return this.mutate(async (state) => {
      const { actor, server } = this.assertServerOwner(state, actorId, serverId);
      const principal = this.principalFrom(state, principalId);
      if (!GRANT_LEVELS.has(level)) throw new AppError('Server grant level is invalid.');
      if (principal.id === server.ownerId) throw new AppError('The server owner already has full access.');
      const existing = state.grants.find((grant) => grant.serverId === serverId && grant.principalId === principal.id);
      if (existing) {
        existing.level = level;
        existing.updatedAt = this.timestamp();
      } else state.grants.push({ id: crypto.randomUUID(), serverId, principalId: principal.id, level, createdAt: this.timestamp(), updatedAt: this.timestamp() });
      this.audit(state, actor.id, 'server.granted', { serverId, principalId, level });
      return copy(state.grants.find((grant) => grant.serverId === serverId && grant.principalId === principal.id));
    });
  }

  async revokeServerGrant(actorId, serverId, principalId) {
    return this.mutate(async (state) => {
      const { actor } = this.assertServerOwner(state, actorId, serverId);
      const originalLength = state.grants.length;
      state.grants = state.grants.filter((grant) => grant.serverId !== serverId || grant.principalId !== principalId);
      if (state.grants.length === originalLength) throw new AppError('Server grant not found.', 404);
      this.audit(state, actor.id, 'server.grant_revoked', { serverId, principalId });
    });
  }

  async listServerGrants(actorId, serverId) {
    const state = await this.read();
    this.assertServerOwner(state, actorId, serverId);
    return state.grants
      .filter((grant) => grant.serverId === serverId)
      .map((grant) => {
        const principal = this.principalFrom(state, grant.principalId, { active: false });
        return { ...copy(grant), principal: { id: principal.id, username: principal.username, displayName: principal.displayName, role: principal.role, status: principal.status } };
      });
  }

  async listShareCandidates(actorId, serverId) {
    const state = await this.read();
    const { server } = this.assertServerOwner(state, actorId, serverId);
    return state.principals
      .filter((principal) => principal.status === 'active' && principal.id !== server.ownerId)
      .map((principal) => ({ id: principal.id, username: principal.username, displayName: principal.displayName, role: principal.role }));
  }

  accessLevel(state, principal, serverId) {
    if (principal.role === 'owner') return 'manage';
    const server = state.servers.find((item) => item.serverId === serverId);
    if (server?.ownerId === principal.id) return principal.role === 'viewer' ? null : 'manage';
    const grant = state.grants.find((item) => item.serverId === serverId && item.principalId === principal.id);
    if (!grant) return null;
    return principal.role === 'viewer' ? 'view' : grant.level;
  }

  async can(principalOrId, action, serverId = null) {
    try {
      const state = await this.read();
      const principal = this.principalFrom(state, principalOrId);
      if (!KNOWN_ACTIONS.has(action)) return false;
      if (principal.role === 'owner') return true;
      if (action === 'server.create') return principal.role === 'member' || principal.role === 'operator';
      if (action === 'server.delete' || action === 'server.grant') {
        return state.servers.some((server) => server.serverId === serverId && server.ownerId === principal.id);
      }
      const required = SERVER_ACTION_LEVELS[action];
      if (!required || !serverId) return false;
      const actual = this.accessLevel(state, principal, serverId);
      return Boolean(actual && GRANT_WEIGHT[actual] >= GRANT_WEIGHT[required]);
    } catch {
      return false;
    }
  }

  async assertAuthorized(principalOrId, action, serverId = null) {
    if (!(await this.can(principalOrId, action, serverId))) throw new AppError('You do not have permission for this action.', 403);
  }

  async listAccessibleServers(principalOrId) {
    const state = await this.read();
    const principal = this.principalFrom(state, principalOrId);
    return state.servers
      .map((server) => ({ ...copy(server), access: this.accessLevel(state, principal, server.serverId) }))
      .filter((server) => server.access);
  }

  async updateServerStorage(actorId, serverId, storageBytes) {
    return this.mutate(async (state) => {
      const actor = this.principalFrom(state, actorId);
      const server = state.servers.find((item) => item.serverId === serverId);
      if (!server) throw new AppError('Server access record not found.', 404);
      const level = this.accessLevel(state, actor, serverId);
      if (!level || GRANT_WEIGHT[level] < GRANT_WEIGHT.manage) throw new AppError('Server manager access is required.', 403);
      storageBytes = finiteLimit(storageBytes, 'storageBytes');
      const previous = server.storageBytes;
      server.storageBytes = storageBytes;
      const owner = this.principalFrom(state, server.ownerId);
      const quota = this.quotaResult(state, owner);
      if (!quota.allowed) {
        server.storageBytes = previous;
        throw new AppError(`Account quota exceeded: ${quota.exceeded.join(', ')}.`, 409);
      }
      server.updatedAt = this.timestamp();
      this.audit(state, actor.id, 'server.storage_updated', { serverId, storageBytes });
      return { serverId, storageBytes, quota };
    });
  }

  async addSshKey(actorId, { principalId = actorId, publicKey, label = 'Computer' }) {
    return this.mutate(async (state) => {
      const actor = this.principalFrom(state, actorId);
      if (principalId !== actor.id && actor.role !== 'owner') throw new AppError('Owner access is required.', 403);
      const principal = this.principalFrom(state, principalId);
      const parsed = parseSshPublicKey(publicKey);
      if (state.principals.some((item) => item.sshKeys.some((key) => key.fingerprint === parsed.fingerprint))) throw new AppError('That SSH key is already registered.', 409);
      const key = { id: crypto.randomUUID(), label: cleanText(label, 'SSH key label', 2, 64), ...parsed, createdAt: this.timestamp(), lastUsedAt: null };
      principal.sshKeys.push(key);
      principal.updatedAt = this.timestamp();
      this.audit(state, actor.id, 'ssh_key.added', { principalId, sshKeyId: key.id, fingerprint: key.fingerprint });
      return copy(key);
    });
  }

  async removeSshKey(actorId, principalId, keyId) {
    return this.mutate(async (state) => {
      const actor = this.principalFrom(state, actorId);
      if (principalId !== actor.id && actor.role !== 'owner') throw new AppError('Owner access is required.', 403);
      const principal = this.principalFrom(state, principalId);
      const originalLength = principal.sshKeys.length;
      principal.sshKeys = principal.sshKeys.filter((key) => key.id !== keyId);
      if (principal.sshKeys.length === originalLength) throw new AppError('SSH key not found.', 404);
      principal.updatedAt = this.timestamp();
      this.audit(state, actor.id, 'ssh_key.removed', { principalId, sshKeyId: keyId });
    });
  }

  async listSshKeys(actorId, principalId = actorId) {
    const state = await this.read();
    const actor = this.principalFrom(state, actorId);
    if (principalId !== actor.id && actor.role !== 'owner') throw new AppError('Owner access is required.', 403);
    return copy(this.principalFrom(state, principalId).sshKeys);
  }

  async renderAuthorizedKeys({ command = '/usr/local/bin/openmchost-ssh', dataDir = this.dataDir } = {}) {
    if (!path.isAbsolute(command) || !/^[a-zA-Z0-9_./:-]+$/.test(command) || !path.isAbsolute(dataDir) || !/^[a-zA-Z0-9_./:-]+$/.test(dataDir)) throw new AppError('SSH gateway path is invalid.');
    const state = await this.read();
    const quote = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const lines = [];
    for (const principal of state.principals.filter((item) => item.status === 'active')) {
      for (const key of principal.sshKeys) {
        const forced = `${command} --data-dir ${dataDir} --principal ${principal.id}`;
        lines.push(`command="${quote(forced)}",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc ${key.publicKey}`);
      }
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  async listAuditEvents(actorId, { limit = 100, principalId = null, serverId = null } = {}) {
    const state = await this.read();
    const actor = this.principalFrom(state, actorId);
    limit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    let events = state.auditEvents;
    if (actor.role !== 'owner') events = events.filter((event) => event.actorId === actor.id || event.principalId === actor.id || (event.serverId && state.servers.some((server) => server.serverId === event.serverId && server.ownerId === actor.id)));
    if (principalId) events = events.filter((event) => event.actorId === principalId || event.principalId === principalId);
    if (serverId) events = events.filter((event) => event.serverId === serverId);
    const identity = (id) => {
      const principal = state.principals.find((item) => item.id === id);
      return principal ? { id: principal.id, username: principal.username, displayName: principal.displayName, role: principal.role } : null;
    };
    return copy(events.slice(-limit).reverse().map((event) => ({
      ...event,
      actor: identity(event.actorId),
      subject: identity(event.principalId)
    })));
  }

  async recordEvent(actorId, action, details = {}) {
    return this.mutate(async (state) => {
      const actor = this.principalFrom(state, actorId);
      const normalizedAction = cleanText(action, 'Audit action', 3, 96);
      const safeDetails = {};
      for (const [key, value] of Object.entries(details).slice(0, 24)) {
        if (!/^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(key)) continue;
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) safeDetails[key] = value;
      }
      return copy(this.audit(state, actor.id, normalizedAction, safeDetails));
    });
  }

  async recordSystemEvent(action, details = {}) {
    return this.mutate(async (state) => {
      const normalizedAction = cleanText(action, 'Audit action', 3, 96);
      const safeDetails = {};
      for (const [key, value] of Object.entries(details).slice(0, 24)) {
        if (!/^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(key)) continue;
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) safeDetails[key] = value;
      }
      return copy(this.audit(state, 'system', normalizedAction, safeDetails));
    });
  }
}

module.exports = {
  AccessService,
  DEFAULT_QUOTAS,
  GRANT_LEVELS,
  KNOWN_ACTIONS,
  ROLES,
  SERVER_ACTION_LEVELS,
  normalizeQuotas,
  parseSshPublicKey,
  publicPrincipal
};
