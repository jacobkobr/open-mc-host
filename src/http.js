const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { AppError } = require('./errors');

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...securityHeaders() });
  response.end(status === 204 ? undefined : JSON.stringify(value));
}

function securityHeaders() {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; img-src 'self' https://cdn.modrinth.com https://hangar.papermc.io https://hangarcdn.papermc.io data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  };
}

async function body(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new AppError('Request body is too large.', 413);
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new AppError('Request body must be valid JSON.'); }
}

function match(pathname, pattern) {
  const result = pathname.match(pattern);
  return result ? result.slice(1).map(decodeURIComponent) : null;
}

function extractBearer(request) {
  const header = String(request.headers.authorization || '');
  const result = header.match(/^Bearer\s+(.+)$/i);
  return result ? result[1].trim() : '';
}

function safeTokenEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isLoopback(request) {
  const address = String(request.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

function requireOwner(principal) {
  if (principal?.role !== 'owner') throw new AppError('Owner access is required.', 403);
}

function queryOptions(url) {
  return {
    query: url.searchParams.get('query') || '',
    kind: url.searchParams.get('kind') || undefined,
    gameVersion: url.searchParams.get('gameVersion') || undefined,
    loader: url.searchParams.get('loader') || undefined,
    platform: url.searchParams.get('platform') || undefined,
    sort: url.searchParams.get('sort') || undefined,
    limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
    offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined
  };
}

function createHandler({ service, runtime, settings, access, sshGatewayToken = '', publicDir, assetsDir = path.join(__dirname, '..', 'assets') }) {
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const { pathname } = url;
      const publicFiles = new Map([['/app.css', 'text/css; charset=utf-8'], ['/app.js', 'text/javascript; charset=utf-8']]);
      const lucideFiles = new Set(['layout-dashboard', 'server', 'plus', 'library-big', 'users-round', 'settings', 'log-out', 'menu', 'panel-left-close', 'refresh-cw', 'search', 'x', 'external-link', 'sun', 'moon'].map((name) => `/assets/lucide/${name}.svg`));
      const fontFiles = new Set(['/assets/fonts/monocraft-regular.ttf', '/assets/fonts/monocraft-semibold.ttf', '/assets/fonts/monocraft-bold.ttf']);
      const publicRoute = pathname === '/' || pathname === '/index.html' || pathname === '/assets/logo.png' || pathname === '/api/v1/health' || publicFiles.has(pathname) || lucideFiles.has(pathname) || fontFiles.has(pathname) || pathname === '/api/v1/access/invites/redeem';

      if (request.method === 'GET' && pathname === '/api/v1/health') return json(response, 200, { ok: true });
      if (request.method === 'POST' && pathname === '/api/v1/ssh/actions') {
        if (!access || !isLoopback(request) || !safeTokenEqual(extractBearer(request), sshGatewayToken)) throw new AppError('SSH gateway authentication failed.', 403);
        const payload = await body(request);
        const principal = await access.getPrincipal(payload.principalId);
        const args = payload.args || {};
        if (payload.action === 'servers.list') return json(response, 200, await service.list(principal));
        if (payload.action === 'servers.status') return json(response, 200, await service.get(args.serverId, principal));
        if (payload.action === 'servers.create') return json(response, 201, await service.create(args, principal));
        const action = String(payload.action || '').match(/^servers\.(start|stop|restart)$/)?.[1];
        if (action) return json(response, 200, await service.action(args.serverId, action, principal));
        throw new AppError('SSH action is not allowed.', 403);
      }

      let principal = null;
      if (!publicRoute) {
        if (!access) throw new AppError('Access control is unavailable.', 503);
        principal = await access.requireAuthenticated(extractBearer(request));
      }

      if (request.method === 'POST' && pathname === '/api/v1/access/invites/redeem') {
        if (!access) throw new AppError('Invite access is unavailable.', 503);
        const payload = await body(request);
        return json(response, 201, await access.redeemInvite(payload.code, payload));
      }
      if (request.method === 'GET' && pathname === '/assets/logo.png') {
        const image = await fs.readFile(path.join(assetsDir, 'logo-mark.png'));
        response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', ...securityHeaders() });
        return response.end(image);
      }
      if (request.method === 'GET' && lucideFiles.has(pathname)) {
        const icon = await fs.readFile(path.join(publicDir, pathname.slice(1)));
        response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', ...securityHeaders() });
        return response.end(icon);
      }
      if (request.method === 'GET' && fontFiles.has(pathname)) {
        const font = await fs.readFile(path.join(publicDir, pathname.slice(1)));
        response.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'public, max-age=31536000, immutable', ...securityHeaders() });
        return response.end(font);
      }
      if (request.method === 'GET' && publicFiles.has(pathname)) {
        const asset = await fs.readFile(path.join(publicDir, pathname.slice(1)));
        response.writeHead(200, { 'content-type': publicFiles.get(pathname), 'cache-control': 'no-cache', ...securityHeaders() });
        return response.end(asset);
      }
      if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const page = await fs.readFile(path.join(publicDir, 'index.html'));
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...securityHeaders() });
        return response.end(page);
      }

      if (request.method === 'GET' && pathname === '/api/v1/me') {
        const quota = access ? await access.checkQuota(principal.id) : null;
        return json(response, 200, { ...principal, quota });
      }
      if (request.method === 'GET' && pathname === '/api/v1/node') return json(response, 200, await runtime.nodeStatus());
      if (request.method === 'GET' && pathname === '/api/v1/settings') return json(response, 200, await settings.get());
      if (request.method === 'GET' && pathname === '/api/v1/settings/connection') return json(response, 200, await settings.connectionStatus());
      if (request.method === 'PATCH' && pathname === '/api/v1/settings') {
        requireOwner(principal);
        const input = await body(request);
        if (Object.hasOwn(input, 'dashboardUrl')) return json(response, 200, await settings.setDashboardUrl(input.dashboardUrl));
        if (Object.hasOwn(input, 'publicHost')) return json(response, 200, await settings.setPublicHost(input.publicHost));
        throw new AppError('Provide publicHost or dashboardUrl.', 400);
      }
      if (request.method === 'GET' && pathname === '/api/v1/catalog') return json(response, 200, service.catalog());
      if (request.method === 'GET' && pathname === '/api/v1/catalog/minecraft-versions') return json(response, 200, await service.minecraftVersions(url.searchParams.get('software') || 'PAPER'));
      if (request.method === 'GET' && pathname === '/api/v1/catalog/builds') return json(response, 200, await service.serverBuilds(url.searchParams.get('software') || 'PAPER', url.searchParams.get('minecraftVersion')));

      let params = match(pathname, /^\/api\/v1\/catalog\/providers\/([^/]+)\/search$/);
      if (params && request.method === 'GET') return json(response, 200, await service.searchProvider(params[0], queryOptions(url)));
      params = match(pathname, /^\/api\/v1\/catalog\/providers\/([^/]+)\/projects\/([^/]+)\/versions$/);
      if (params && request.method === 'GET') return json(response, 200, await service.providerVersions(params[0], { ...queryOptions(url), projectId: params[1] }));

      if (access && request.method === 'GET' && pathname === '/api/v1/access/principals') return json(response, 200, await access.listPrincipals(principal.id));
      if (access && request.method === 'GET' && pathname === '/api/v1/access/invites') return json(response, 200, await access.listInvites(principal.id));
      if (access && request.method === 'POST' && pathname === '/api/v1/access/invites') return json(response, 201, await access.createInvite(principal.id, await body(request)));
      params = match(pathname, /^\/api\/v1\/access\/invites\/([^/]+)$/);
      if (access && params && request.method === 'DELETE') { await access.revokeInvite(principal.id, params[0]); return json(response, 204, null); }
      params = match(pathname, /^\/api\/v1\/access\/principals\/([^/]+)$/);
      if (access && params && request.method === 'GET') return json(response, 200, await access.getPrincipal(principal.id, params[0]));
      if (access && params && request.method === 'PATCH') return json(response, 200, await access.updatePrincipal(principal.id, params[0], await body(request)));
      params = match(pathname, /^\/api\/v1\/access\/principals\/([^/]+)\/credentials$/);
      if (access && params && request.method === 'GET') return json(response, 200, await access.listCredentials(principal.id, params[0]));
      if (access && params && request.method === 'POST') return json(response, 201, await access.createCredential(principal.id, { ...(await body(request)), principalId: params[0] }));
      params = match(pathname, /^\/api\/v1\/access\/principals\/([^/]+)\/credentials\/([^/]+)$/);
      if (access && params && request.method === 'DELETE') { await access.revokeCredential(principal.id, params[0], params[1]); return json(response, 204, null); }
      if (access && params && request.method === 'PATCH') return json(response, 200, await access.restoreCredential(principal.id, params[0], params[1]));
      params = match(pathname, /^\/api\/v1\/access\/principals\/([^/]+)\/credentials\/([^/]+)\/delete$/);
      if (access && params && request.method === 'POST') { await access.deleteCredential(principal.id, params[0], params[1]); return json(response, 204, null); }
      params = match(pathname, /^\/api\/v1\/access\/principals\/([^/]+)\/ssh-keys$/);
      if (access && params && request.method === 'GET') return json(response, 200, await access.listSshKeys(principal.id, params[0]));
      if (access && params && request.method === 'POST') return json(response, 201, await access.addSshKey(principal.id, { ...(await body(request)), principalId: params[0] }));
      params = match(pathname, /^\/api\/v1\/access\/principals\/([^/]+)\/ssh-keys\/([^/]+)$/);
      if (access && params && request.method === 'DELETE') { await access.removeSshKey(principal.id, params[0], params[1]); return json(response, 204, null); }
      if (access && request.method === 'GET' && pathname === '/api/v1/access/audit') return json(response, 200, await access.listAuditEvents(principal.id, { limit: url.searchParams.get('limit'), principalId: url.searchParams.get('principalId'), serverId: url.searchParams.get('serverId') }));

      if (request.method === 'GET' && pathname === '/api/v1/servers') return json(response, 200, await service.list(principal));
      if (request.method === 'POST' && pathname === '/api/v1/servers') return json(response, 201, await service.create(await body(request), principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)$/);
      if (params && request.method === 'GET') return json(response, 200, await service.get(params[0], principal));
      if (params && request.method === 'DELETE') { await service.delete(params[0], principal); return json(response, 204, null); }
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/(start|stop|restart|rebuild)$/);
      if (params && request.method === 'POST') return json(response, 200, await service.action(params[0], params[1], principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/logs$/);
      if (params && request.method === 'GET') return json(response, 200, { logs: await service.logs(params[0], url.searchParams.get('tail'), url.searchParams.get('since'), url.searchParams.get('until'), principal) });
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/metrics$/);
      if (params && request.method === 'GET') return json(response, 200, await service.metrics(params[0], principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/connectivity$/);
      if (params && (request.method === 'GET' || request.method === 'POST')) return json(response, 200, await service.connectivity(params[0], principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/files$/);
      if (params && request.method === 'GET') return json(response, 200, await service.files(params[0], url.searchParams.get('path') || '.', principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/file$/);
      if (params && request.method === 'GET') return json(response, 200, await service.readFile(params[0], url.searchParams.get('path'), principal));
      if (params && request.method === 'PUT') { const payload = await body(request); return json(response, 200, await service.writeFile(params[0], payload.path, payload.content, principal)); }
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/files\/upload$/);
      if (params && request.method === 'PUT') return json(response, 201, await service.uploadFile(params[0], url.searchParams.get('path'), request, request.headers['content-length'], principal, url.searchParams.get('replace') === 'true'));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/files\/download$/);
      if (params && request.method === 'GET') {
        const file = await service.downloadFile(params[0], url.searchParams.get('path'), principal);
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, ...securityHeaders() });
        return fsSync.createReadStream(file.filePath).pipe(response);
      }
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/directories$/);
      if (params && request.method === 'POST') return json(response, 201, await service.createDirectory(params[0], (await body(request)).path, principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/files\/rename$/);
      if (params && request.method === 'POST') { const payload = await body(request); return json(response, 200, await service.renameFile(params[0], payload.path, payload.destination, principal, payload.replace === true)); }
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/files\/entry$/);
      if (params && request.method === 'DELETE') return json(response, 200, await service.deleteFile(params[0], url.searchParams.get('path'), principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/command$/);
      if (params && request.method === 'POST') { await service.command(params[0], (await body(request)).command, principal); return json(response, 202, { accepted: true }); }
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/content\/install$/);
      if (params && request.method === 'POST') return json(response, 201, await service.installProviderContent(params[0], await body(request), principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/content$/);
      if (params && request.method === 'GET') return json(response, 200, await service.installedContent(params[0], principal));
      if (params && request.method === 'PATCH') { const payload = await body(request); return json(response, 200, await service.setContentEnabled(params[0], payload.path, payload.enabled, principal)); }
      if (params && request.method === 'DELETE') return json(response, 200, await service.removeContent(params[0], url.searchParams.get('path'), principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/backups$/);
      if (params && request.method === 'GET') return json(response, 200, await service.backups(params[0], principal));
      if (params && request.method === 'POST') return json(response, 201, await service.backup(params[0], principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/backups\/import$/);
      if (params && request.method === 'PUT') return json(response, 201, await service.importBackup(params[0], request, request.headers['content-length'], principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/backups\/([^/]+)\/download$/);
      if (params && request.method === 'GET') {
        const file = await service.downloadBackup(params[0], params[1], principal);
        response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': file.size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, ...securityHeaders() });
        return fsSync.createReadStream(file.filePath).pipe(response);
      }
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/backups\/([^/]+)\/restore$/);
      if (params && request.method === 'POST') return json(response, 200, await service.restore(params[0], params[1], principal));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/backups\/([^/]+)$/);
      if (params && request.method === 'DELETE') { await service.deleteBackup(params[0], params[1], principal); return json(response, 204, null); }
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/grants$/);
      if (access && params && request.method === 'GET') return json(response, 200, await access.listServerGrants(principal.id, params[0]));
      if (access && params && request.method === 'POST') return json(response, 201, await access.grantServer(principal.id, { ...(await body(request)), serverId: params[0] }));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/share-candidates$/);
      if (access && params && request.method === 'GET') return json(response, 200, await access.listShareCandidates(principal.id, params[0]));
      params = match(pathname, /^\/api\/v1\/servers\/([^/]+)\/grants\/([^/]+)$/);
      if (access && params && request.method === 'DELETE') { await access.revokeServerGrant(principal.id, params[0], params[1]); return json(response, 204, null); }

      return json(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const message = status === 500 && !(error instanceof AppError) ? 'Unexpected server error.' : error.message || 'Unexpected server error.';
      return json(response, status, { error: message });
    }
  };
}

module.exports = { createHandler, extractBearer, isLoopback, securityHeaders };
