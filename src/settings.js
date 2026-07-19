const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const { AppError } = require('./errors');

class SettingsStore {
  constructor({ dataDir, publicHost, dashboardUrl }) {
    this.file = path.join(dataDir, 'settings.json');
    this.defaultSettings = {
      publicHost: isReservedExampleHost(publicHost) ? '' : normalizePublicHost(publicHost),
      dashboardUrl: normalizeDashboardUrl(dashboardUrl)
    };
  }

  async initialize() {
    try {
      const settings = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const next = {
        ...settings,
        publicHost: normalizeStoredPublicHost(settings.publicHost, this.defaultSettings.publicHost),
        dashboardUrl: normalizeStoredDashboardUrl(settings.dashboardUrl, this.defaultSettings.dashboardUrl)
      };
      if (JSON.stringify(next) !== JSON.stringify(settings)) await this.write(next);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.write(this.defaultSettings);
    }
  }

  async get() {
    return JSON.parse(await fs.readFile(this.file, 'utf8'));
  }

  async setPublicHost(value) {
    const settings = await this.get();
    settings.publicHost = normalizePublicHost(value);
    await this.write(settings);
    return settings;
  }

  async setDashboardUrl(value) {
    const settings = await this.get();
    settings.dashboardUrl = normalizeDashboardUrl(value);
    await this.write(settings);
    return settings;
  }

  async connectionStatus() {
    const { publicHost } = await this.get();
    if (!publicHost) return { configured: false, state: 'missing', addresses: [] };
    const host = publicHost.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return { configured: true, state: 'address', addresses: [host] };
    try {
      const entries = await dns.lookup(host, { all: true });
      return { configured: true, state: 'resolved', addresses: [...new Set(entries.map((entry) => entry.address))] };
    } catch {
      return { configured: true, state: 'unresolved', addresses: [] };
    }
  }

  async write(settings) {
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.file);
  }
}

function normalizePublicHost(value) {
  const host = String(value || '').trim();
  if (!host) return '';
  if (isReservedExampleHost(host)) throw new AppError('Reserved example addresses cannot be used as a public join address.');
  if (host.startsWith('[') && host.endsWith(']') && net.isIP(host.slice(1, -1)) === 6) return host;
  if (net.isIP(host) === 4) return host;
  if (/^[0-9.]+$/.test(host) || host.length > 253) throw new AppError('Public join address must be a valid hostname, IPv4 address, or bracketed IPv6 address.');
  const labels = host.split('.');
  if (labels.every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) return host;
  throw new AppError('Public join address must be a valid hostname, IPv4 address, or bracketed IPv6 address.');
}

function normalizeDashboardUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError('Friend dashboard URL must be a complete HTTPS address, such as https://panel.yourdomain.com.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new AppError('Friend dashboard URL must be an HTTPS origin without a path, query, fragment, or credentials.');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (['localhost', '127.0.0.1', '::1'].includes(host)) throw new AppError('Friend dashboard URL cannot use localhost. Configure the HTTPS address that friends can reach.');
  normalizePublicHost(parsed.hostname);
  return parsed.origin;
}

function normalizeStoredPublicHost(value, fallback) {
  if (isReservedExampleHost(value)) return '';
  try {
    return normalizePublicHost(value === undefined ? fallback : value);
  } catch {
    return '';
  }
}

function normalizeStoredDashboardUrl(value, fallback) {
  try {
    return normalizeDashboardUrl(value === undefined ? fallback : value);
  } catch {
    return '';
  }
}

function isReservedExampleHost(value) {
  const host = String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  return /(^|\.)example\.(com|net|org)$/.test(host)
    || /^192\.0\.2\.\d{1,3}$/.test(host)
    || /^198\.51\.100\.\d{1,3}$/.test(host)
    || /^203\.0\.113\.\d{1,3}$/.test(host);
}

module.exports = { SettingsStore, normalizePublicHost, normalizeDashboardUrl, isReservedExampleHost };
