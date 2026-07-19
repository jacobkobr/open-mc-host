const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('./errors');

class ServerStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'servers.json');
    this.mutation = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      await fs.access(this.file);
    } catch {
      await this.write([]);
    }
  }

  async read() {
    return JSON.parse(await fs.readFile(this.file, 'utf8'));
  }

  async write(servers) {
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(servers, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.file);
  }

  async list() {
    return this.read();
  }

  async get(id) {
    const server = (await this.read()).find((item) => item.id === id);
    if (!server) throw new AppError('Server not found.', 404);
    return server;
  }

  async create(input) {
    return this.mutate(async (servers) => {
      const id = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const server = { ...input, id, createdAt: timestamp, updatedAt: timestamp, containerName: `open-mc-host-${id}` };
      servers.push(server);
      return server;
    });
  }

  async update(id, changes) {
    return this.mutate(async (servers) => {
      const index = servers.findIndex((item) => item.id === id);
      if (index === -1) throw new AppError('Server not found.', 404);
      servers[index] = { ...servers[index], ...changes, id, updatedAt: new Date().toISOString() };
      return servers[index];
    });
  }

  async remove(id) {
    return this.mutate(async (servers) => {
      const index = servers.findIndex((item) => item.id === id);
      if (index === -1) throw new AppError('Server not found.', 404);
      const [existing] = servers.splice(index, 1);
      return existing;
    });
  }

  async mutate(operation) {
    const mutation = this.mutation.then(async () => {
      const servers = await this.read();
      const result = await operation(servers);
      await this.write(servers);
      return result;
    });
    this.mutation = mutation.catch(() => {});
    return mutation;
  }
}

module.exports = { ServerStore };
