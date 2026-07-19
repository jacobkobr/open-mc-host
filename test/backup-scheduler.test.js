const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BackupScheduler, normalizeHour } = require('../src/backup-scheduler');

test('creates one persistent automatic backup per server each day', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-mc-host-schedule-'));
  const calls = [];
  const dependencies = {
    dataDir,
    hour: 3,
    store: { list: async () => [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }] },
    service: { automaticBackup: async (id) => { calls.push(id); } },
    logger: { error() {}, warn() {} }
  };
  const scheduler = new BackupScheduler(dependencies);
  await scheduler.initialize();
  assert.deepEqual(await scheduler.tick(new Date('2026-07-18T02:59:00.000Z')), { scheduled: false, completed: 0, failed: 0 });
  assert.deepEqual(await scheduler.tick(new Date('2026-07-18T03:00:00.000Z')), { scheduled: true, completed: 2, failed: 0 });
  assert.deepEqual(calls, ['one', 'two']);
  assert.deepEqual(await scheduler.tick(new Date('2026-07-18T10:00:00.000Z')), { scheduled: true, completed: 0, failed: 0 });
  const restarted = new BackupScheduler(dependencies);
  await restarted.initialize();
  await restarted.tick(new Date('2026-07-18T12:00:00.000Z'));
  assert.deepEqual(calls, ['one', 'two']);
  await restarted.tick(new Date('2026-07-19T03:00:00.000Z'));
  assert.deepEqual(calls, ['one', 'two', 'one', 'two']);
});

test('validates daily backup hour', () => {
  assert.equal(normalizeHour(0), 0);
  assert.equal(normalizeHour(23), 23);
  assert.throws(() => normalizeHour(24));
});
