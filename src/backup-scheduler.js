const fs = require('node:fs/promises');
const path = require('node:path');

class BackupScheduler {
  constructor({ service, store, dataDir, enabled = true, hour = 3, now = () => new Date(), logger = console, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
    this.service = service;
    this.store = store;
    this.file = path.join(dataDir, 'automatic-backups.json');
    this.enabled = enabled;
    this.hour = normalizeHour(hour);
    this.now = now;
    this.logger = logger;
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.state = { version: 1, completed: {} };
    this.timer = null;
    this.running = null;
  }

  async initialize() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed?.version === 1 && parsed.completed && typeof parsed.completed === 'object') this.state = { version: 1, completed: parsed.completed };
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn?.(`Unable to read automatic backup schedule: ${error.message}`);
    }
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.timer = this.setInterval(() => this.tick().catch((error) => this.logger.error?.(`Automatic backup scheduler failed: ${error.message}`)), 60_000);
    this.timer.unref?.();
    this.tick().catch((error) => this.logger.error?.(`Automatic backup scheduler failed: ${error.message}`));
  }

  stop() {
    if (!this.timer) return;
    this.clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = this.now()) {
    if (!this.enabled || now.getUTCHours() < this.hour) return { scheduled: false, completed: 0, failed: 0 };
    if (this.running) return this.running;
    this.running = this.run(now).finally(() => { this.running = null; });
    return this.running;
  }

  async run(now) {
    const day = now.toISOString().slice(0, 10);
    const servers = await this.store.list();
    const activeIds = new Set(servers.map((server) => server.id));
    for (const id of Object.keys(this.state.completed)) if (!activeIds.has(id)) delete this.state.completed[id];
    let completed = 0;
    let failed = 0;
    for (const server of servers) {
      if (this.state.completed[server.id] === day) continue;
      try {
        await this.service.automaticBackup(server.id);
        this.state.completed[server.id] = day;
        await this.save();
        completed += 1;
      } catch (error) {
        failed += 1;
        this.logger.error?.(`Automatic backup failed for ${server.name || server.id}: ${error.message}`);
      }
    }
    return { scheduled: true, completed, failed };
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.file);
  }
}

function normalizeHour(value) {
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('MC_HOST_AUTO_BACKUP_HOUR must be an integer from 0 through 23.');
  return hour;
}

module.exports = { BackupScheduler, normalizeHour };
