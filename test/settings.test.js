const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore, normalizePublicHost, normalizeDashboardUrl, isReservedExampleHost } = require('../src/settings');

test('persists a safe public join address', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-mc-host-settings-'));
  const settings = new SettingsStore({ dataDir, publicHost: '1.1.1.1' });
  await settings.initialize();
  assert.equal((await settings.get()).publicHost, '1.1.1.1');
  assert.equal((await settings.setPublicHost('8.8.8.8')).publicHost, '8.8.8.8');
  assert.deepEqual(await settings.connectionStatus(), { configured: true, state: 'address', addresses: ['8.8.8.8'] });
  assert.equal(normalizePublicHost('mc.yourdomain.com'), 'mc.yourdomain.com');
  assert.equal(normalizePublicHost('[2001:db8::1]'), '[2001:db8::1]');
  assert.equal(normalizeDashboardUrl('https://panel.yourdomain.com/'), 'https://panel.yourdomain.com');
  assert.throws(() => normalizePublicHost('https://example.com'), { status: 400 });
  assert.throws(() => normalizePublicHost('mc.example.com'), { status: 400 });
  assert.throws(() => normalizePublicHost('999.999.999.999'), { status: 400 });
  assert.throws(() => normalizePublicHost('host..name'), { status: 400 });
  assert.throws(() => normalizePublicHost('-invalid.example'), { status: 400 });
  assert.throws(() => normalizeDashboardUrl('http://panel.yourdomain.com'), { status: 400 });
  assert.throws(() => normalizeDashboardUrl('https://localhost:3000'), { status: 400 });
  assert.throws(() => normalizeDashboardUrl('https://panel.yourdomain.com/dashboard'), { status: 400 });
  assert.throws(() => normalizeDashboardUrl('https://panel.example.com'), { status: 400 });
  assert.equal(isReservedExampleHost('203.0.113.10'), true);
});

test('clears a stale reserved example address during startup migration', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-mc-host-settings-'));
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ publicHost: 'mc.example.com' }));
  const settings = new SettingsStore({ dataDir, publicHost: 'mc.example.com' });
  await settings.initialize();
  assert.deepEqual(await settings.get(), { publicHost: '', dashboardUrl: '' });
});
