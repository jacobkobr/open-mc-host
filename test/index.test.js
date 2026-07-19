const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateServerAccess } = require('../src/index');

test('startup migration preserves friend ownership and repairs only legacy records', async () => {
  const servers = [
    { id: 'friend-server', ownerId: 'friend-id', createdById: 'friend-id', memory: '4G' },
    { id: 'legacy-server', ownerId: 'owner', createdById: 'owner', memory: '2G' }
  ];
  const updates = [];
  const registrations = [];
  const store = {
    async list() { return servers; },
    async update(id, values) { updates.push({ id, values }); }
  };
  const access = {
    async listAccessibleServers() { return [{ serverId: 'friend-server', ownerId: 'friend-id', access: 'manage' }]; },
    async registerServer(actorId, values) { registrations.push({ actorId, values }); return { ...values }; }
  };
  await migrateServerAccess(store, access, { id: 'owner-id', role: 'owner' });
  assert.deepEqual(registrations, [{ actorId: 'owner-id', values: { serverId: 'legacy-server', ownerId: 'owner-id', memoryMiB: 2048, storageBytes: 0 } }]);
  assert.deepEqual(updates, [{ id: 'legacy-server', values: { ownerId: 'owner-id', createdById: 'owner-id' } }]);
});
