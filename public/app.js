(() => {
  'use strict';

  const API_ROOT = '/api/v1';
  const ROUTES = {
    overview: ['Infrastructure', 'Overview'],
    servers: ['Fleet', 'Servers'],
    create: ['Provisioning', 'Create server'],
    content: ['Catalog', 'Content catalog'],
    access: ['Administration', 'People & access'],
    settings: ['Configuration', 'Settings']
  };
  const state = {
    token: normalizeToken(localStorage.getItem('omh.accessKey') || ''),
    route: 'overview',
    principal: null,
    servers: [],
    selectedServerId: null,
    catalog: { software: [] },
    node: null,
    settings: null,
    connection: null,
    serverMetrics: new Map(),
    overviewMonitorId: localStorage.getItem('omh.overviewMonitorId') || null,
    detectedSshHost: null,
    provider: 'modrinth',
    serverTabs: new Map(),
    filePaths: new Map(),
    selectedFiles: new Map(),
    currentFiles: new Map(),
    modpackProvision: null,
    requests: { minecraftVersions: 0, builds: 0, catalogSearch: 0, projectVersions: 0 },
    busy: 0
  };

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clear = (node) => node.replaceChildren();

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function lucideIcon(name) {
    const node = make('span', `lucide-icon icon-${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function normalizeToken(value) {
    let token = String(value || '').trim();
    token = token.replace(/^MC_HOST_API_TOKEN\s*=\s*/i, '').trim();
    token = token.replace(/^Bearer\s+/i, '').trim();
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) token = token.slice(1, -1).trim();
    return token;
  }

  function unwrapList(value, ...keys) {
    if (Array.isArray(value)) return value;
    for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
    return [];
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const requestToken = state.token;
    if (options.auth !== false && requestToken) headers.set('authorization', `Bearer ${requestToken}`);
    let requestBody = options.body;
    if (options.json !== undefined) {
      headers.set('content-type', 'application/json');
      requestBody = JSON.stringify(options.json);
    }
    const response = await fetch(`${API_ROOT}${path}`, {
      method: options.method || (requestBody === undefined ? 'GET' : 'POST'),
      headers,
      body: requestBody
    });
    if (!response.ok) {
      let message = `Request failed (${response.status}).`;
      try { message = (await response.json()).error || message; } catch { /* Response was not JSON. */ }
      if (response.status === 401 && options.auth !== false && state.token === requestToken) {
        state.token = '';
        state.principal = null;
        localStorage.removeItem('omh.accessKey');
        setGlobalState('Access key needed', 'warning');
        showAccessDialog(message);
      }
      throw new ApiError(message, response.status);
    }
    if (options.response === 'raw') return response;
    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('application/json') ? response.json() : response.text();
  }

  function setGlobalState(label, kind = 'neutral') {
    const node = $('#global-state');
    if (!node) return;
    node.textContent = label;
    node.className = `status-pill ${kind}`;
  }

  let noticeTimer;
  function notify(message, kind = 'neutral', timeout = 5000) {
    const node = $('#notice');
    node.textContent = String(message || '');
    node.className = `notice visible ${kind}`;
    clearTimeout(noticeTimer);
    if (timeout) noticeTimer = setTimeout(() => { node.className = 'notice'; }, timeout);
  }

  async function withBusy(button, work) {
    const oldText = button?.textContent;
    const iconButton = button?.classList.contains('icon-button');
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      if (iconButton) button.classList.add('is-busy');
      else button.textContent = 'Working…';
    }
    state.busy += 1;
    try { return await work(); }
    catch (error) {
      notify(error.message || 'Something went wrong.', 'error', 7000);
      throw error;
    } finally {
      state.busy -= 1;
      if (button) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.classList.remove('is-busy');
        if (!iconButton) button.textContent = oldText;
      }
    }
  }

  function showAccessDialog(message = '') {
    const dialog = $('#access-dialog');
    $('#access-error').textContent = message;
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $('#access-key').focus());
  }

  function closeAccessDialog() {
    const dialog = $('#access-dialog');
    if (dialog.open) dialog.close();
    $('#access-error').textContent = '';
  }

  async function connectWithToken(value) {
    const token = normalizeToken(value);
    if (!token) throw new ApiError('Paste an access key first.', 400);
    if (token.startsWith('omhi_')) {
      closeAccessDialog();
      showInviteRedemption(token);
      return;
    }
    state.token = token;
    try {
      await api('/catalog');
    } catch (error) {
      state.token = '';
      throw error;
    }
    localStorage.setItem('omh.accessKey', token);
    closeAccessDialog();
    await refreshAll();
  }

  function ensureInviteDialog() {
    let dialog = $('#invite-dialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'invite-dialog';
    const form = make('form', 'auth-card');
    form.id = 'invite-form';
    const eyebrow = make('p', 'eyebrow', 'Friend invite');
    const heading = make('h2', '', 'Set up your dashboard');
    const intro = make('p', 'muted', 'Choose a simple username. Your invite is exchanged for a private access key stored in this browser.');
    const usernameLabel = make('label', '', 'Username');
    const username = document.createElement('input');
    username.name = 'username';
    username.required = true;
    username.minLength = 3;
    username.maxLength = 32;
    username.pattern = '[a-z0-9][a-z0-9_.-]{2,31}';
    username.placeholder = 'alex';
    usernameLabel.append(username);
    const nameLabel = make('label', '', 'Display name');
    const displayName = document.createElement('input');
    displayName.name = 'displayName';
    displayName.required = true;
    displayName.maxLength = 64;
    displayName.placeholder = 'Alex';
    nameLabel.append(displayName);
    const code = document.createElement('input');
    code.name = 'code';
    code.type = 'hidden';
    const submit = make('button', '', 'Accept invite');
    submit.type = 'submit';
    const cancel = make('button', 'secondary', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      dialog.close();
      if (!state.token) showAccessDialog();
    });
    const actions = make('div', 'form-grid two-col');
    actions.append(cancel, submit);
    const error = make('small', 'error-text');
    error.id = 'invite-error';
    form.append(eyebrow, heading, intro, usernameLabel, nameLabel, code, actions, error);
    dialog.append(form);
    document.body.append(dialog);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      try {
        await withBusy(submit, async () => {
          const data = new FormData(form);
          const result = await api('/access/invites/redeem', {
            method: 'POST',
            auth: false,
            json: { code: data.get('code'), username: data.get('username'), displayName: data.get('displayName'), credentialLabel: 'Web dashboard' }
          });
          const credential = normalizeToken(result?.credential || result?.token || '');
          if (!credential) throw new ApiError('The invite was accepted, but no access key was returned.', 502);
          state.token = credential;
          localStorage.setItem('omh.accessKey', credential);
          dialog.close();
          closeAccessDialog();
          history.replaceState(null, '', '#overview');
          await refreshAll();
          notify('Welcome. Your dashboard access is ready.', 'success');
        });
      } catch (caught) { error.textContent = caught.message; }
    });
    return dialog;
  }

  function showInviteRedemption(code) {
    const dialog = ensureInviteDialog();
    const form = $('#invite-form', dialog);
    form.elements.code.value = code;
    $('#invite-error', dialog).textContent = '';
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => form.elements.username.focus());
  }

  async function loadPrincipal() {
    try {
      const result = await api('/me');
      state.principal = result?.principal || result;
    } catch (error) {
      if (error.status !== 404) throw error;
      state.principal = { id: 'owner', username: 'owner', displayName: 'Owner', role: 'owner', status: 'active' };
    }
    applyPermissions();
  }

  function applyPermissions() {
    const owner = state.principal?.role === 'owner';
    const creator = ['owner', 'member', 'operator'].includes(state.principal?.role);
    $$('.owner-only').forEach((node) => { node.hidden = !owner; });
    $$('.creator-only').forEach((node) => { node.hidden = !creator; });
    if ((!owner && ['access', 'settings'].includes(state.route)) || (!creator && state.route === 'create')) navigate('overview');
  }

  async function refreshAll() {
    if (!state.token) {
      setGlobalState('Access key needed', 'warning');
      showAccessDialog();
      return;
    }
    setGlobalState('Connecting');
    try {
      await loadPrincipal();
      const results = await Promise.allSettled([
        api('/catalog'),
        api('/servers'),
        api('/node'),
        api('/settings'),
        api('/settings/connection')
      ]);
      if (results[0].status === 'fulfilled') state.catalog = results[0].value || { software: [] };
      if (results[1].status === 'fulfilled') state.servers = unwrapList(results[1].value, 'servers', 'items');
      if (results[2].status === 'fulfilled') state.node = results[2].value;
      if (results[3].status === 'fulfilled') state.settings = results[3].value;
      if (results[4].status === 'fulfilled') state.connection = results[4].value;
      renderSshCommands();
      const failure = results.find((result) => result.status === 'rejected' && result.reason?.status !== 404);
      if (failure) notify(failure.reason.message, 'error', 7000);
      if (!state.selectedServerId || !state.servers.some((server) => server.id === state.selectedServerId)) state.selectedServerId = state.servers[0]?.id || null;
      hydrateCatalogControls();
      renderCurrentRoute();
      loadOverviewTelemetry().catch(() => {});
      loadSshKeys().catch(() => {});
      setGlobalState('Connected', 'success');
      loadMinecraftVersions().catch(() => {});
    } catch (error) {
      setGlobalState(error.status === 401 ? 'Access key needed' : 'Unavailable', error.status === 401 ? 'warning' : 'error');
      if (error.status !== 401) notify(error.message, 'error', 7000);
    }
  }

  function routeFromLocation() {
    const hash = location.hash.slice(1);
    if (hash.startsWith('invite=')) return 'overview';
    return ROUTES[hash] ? hash : 'overview';
  }

  const mobileNavigationMedia = matchMedia('(max-width: 860px)');

  function setSidebarCollapsed(collapsed) {
    const desktop = !mobileNavigationMedia.matches;
    const enabled = desktop && Boolean(collapsed);
    document.body.classList.toggle('sidebar-collapsed', enabled);
    const toggleZone = $('#sidebar-toggle-zone');
    toggleZone.setAttribute('aria-label', 'Expand navigation');
    localStorage.setItem('omh.sidebarCollapsed', String(Boolean(collapsed)));
  }

  function setMobileNavigation(open, returnFocus = false) {
    const mobile = mobileNavigationMedia.matches;
    const expanded = mobile && Boolean(open);
    const sidebar = $('#sidebar-navigation');
    const toggle = $('#mobile-nav');
    const overlay = $('#nav-overlay');
    document.body.classList.toggle('nav-open', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? 'Close navigation' : 'Open navigation');
    overlay.hidden = !expanded;
    if (mobile) {
      sidebar.toggleAttribute('inert', !expanded);
      sidebar.setAttribute('aria-hidden', String(!expanded));
    } else {
      sidebar.removeAttribute('inert');
      sidebar.removeAttribute('aria-hidden');
    }
    if (expanded) requestAnimationFrame(() => $('.nav-item:not([hidden])', sidebar)?.focus());
    else if (returnFocus) toggle.focus();
  }

  function navigate(route) {
    if (!ROUTES[route]) route = 'overview';
    if (['access', 'settings'].includes(route) && state.principal?.role !== 'owner') route = 'overview';
    if (route === 'create' && !['owner', 'member', 'operator'].includes(state.principal?.role)) route = 'overview';
    if (location.hash !== `#${route}`) location.hash = route;
    else {
      state.route = route;
      renderCurrentRoute();
    }
    setMobileNavigation(false);
  }

  function renderCurrentRoute() {
    state.route = routeFromLocation();
    if (['access', 'settings'].includes(state.route) && state.principal?.role !== 'owner') state.route = 'overview';
    if (state.route === 'create' && !['owner', 'member', 'operator'].includes(state.principal?.role)) state.route = 'overview';
    const [, title] = ROUTES[state.route];
    $('#page-title').textContent = title;
    $$('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === state.route));
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.route === state.route));
    if (state.route === 'overview') renderOverview();
    if (state.route === 'servers') renderServers();
    if (state.route === 'content') hydrateCatalogServerSelect();
    if (state.route === 'access') { loadMembers(); loadInvites(); loadAccessAudit(); }
    if (state.route === 'settings') renderSettings();
  }

  function statusClass(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'running') return 'running';
    if (['missing', 'error', 'dead'].includes(value)) return 'error';
    return '';
  }

  function serverSubtitle(server) {
    const build = server.build ? ` build ${server.build}` : '';
    return `${server.software || 'Minecraft'} ${server.version || 'LATEST'}${build} · ${server.status || 'unknown'}`;
  }

  function createServerRow(server, compact = false) {
    const button = make('button', `server-row${server.id === state.selectedServerId ? ' active' : ''}`);
    button.type = 'button';
    const dot = make('span', `status-dot ${statusClass(server.status)}`);
    const details = make('span');
    details.append(make('strong', '', server.name), make('small', '', serverSubtitle(server)));
    const tail = make('small', '', compact ? String(server.port || '') : '›');
    button.append(dot, details, tail);
    button.addEventListener('click', () => {
      state.selectedServerId = server.id;
      navigate('servers');
      renderServers();
    });
    return button;
  }

  function renderOverview() {
    $('#metric-servers').textContent = state.servers.length;
    $('#metric-running').textContent = state.servers.filter((server) => server.status === 'running').length;
    $('#metric-containers').textContent = state.node?.containers ?? '—';
    $('#metric-public').textContent = state.settings?.publicHost || state.connection?.addresses?.[0] || 'Not set';
    renderOverviewMonitor();
    const recent = $('#recent-servers');
    clear(recent);
    if (!state.servers.length) emptyState(recent, 'No servers yet', 'Create your first server with an exact version and automatic port.');
    else state.servers.slice(0, 5).forEach((server) => recent.append(createServerRow(server, true)));
    const checklist = $('#host-checklist');
    clear(checklist);
    const panelExposure = state.node?.panel;
    const panelKind = panelExposure?.loopbackOnly === true ? 'success' : panelExposure?.loopbackOnly === false ? 'error' : 'neutral';
    const panelLabel = panelExposure?.loopbackOnly === true ? 'Dashboard published on loopback only' : panelExposure?.loopbackOnly === false ? 'Dashboard is network-exposed; add HTTPS and restrict access' : 'Dashboard exposure could not be verified';
    const checks = [
      [state.node?.runtime ? 'success' : 'neutral', 'Docker node connected'],
      [state.settings?.publicHost || state.connection?.addresses?.length ? 'success' : 'neutral', 'Public join address configured or detected'],
      [state.servers.some((server) => server.status === 'running') ? 'success' : 'neutral', 'At least one server running'],
      [panelKind, panelLabel]
    ];
    checks.forEach(([kind, label]) => checklist.append(checkItem(label, kind)));
  }

  function renderOverviewMonitor() {
    const select = $('#overview-monitor-select');
    const candidate = state.servers.find((server) => server.id === state.overviewMonitorId) || state.servers.find((server) => server.status === 'running') || state.servers[0] || null;
    state.overviewMonitorId = candidate?.id || null;
    clear(select);
    if (!candidate) {
      select.disabled = true;
      select.append(make('option', '', 'No servers available'));
      setOverviewMonitorValues();
      return;
    }
    state.servers.forEach((server) => {
      const option = make('option', '', `${server.name} · ${server.status}`);
      option.value = server.id;
      option.selected = server.id === candidate.id;
      select.append(option);
    });
    select.disabled = false;
    const metrics = state.serverMetrics.get(candidate.id);
    setOverviewMonitorValues(metrics);
  }

  function setOverviewMonitorValues(metrics = null) {
    $('#overview-monitor-cpu').textContent = metrics?.CPUPerc || metrics?.cpu || '—';
    $('#overview-monitor-memory').textContent = metrics?.MemUsage || metrics?.memory || '—';
    $('#overview-monitor-players').textContent = metrics?.playersOnline === null || metrics?.playersOnline === undefined ? '—' : `${metrics.playersOnline} / ${metrics.maxPlayers ?? '—'}`;
    $('#overview-monitor-uptime').textContent = metrics?.uptimeSeconds === null || metrics?.uptimeSeconds === undefined ? '—' : formatDuration(metrics.uptimeSeconds);
    $('#overview-monitor-network').textContent = metrics?.NetIO || metrics?.network || '—';
    $('#overview-monitor-block').textContent = metrics?.BlockIO || metrics?.block || '—';
  }

  async function refreshOverviewMonitor(button) {
    const server = state.servers.find((item) => item.id === state.overviewMonitorId);
    if (!server || server.status !== 'running') return notify('Start the selected server to collect live resource usage.', 'warning');
    await withBusy(button, async () => {
      state.serverMetrics.set(server.id, await api(`/servers/${encodeURIComponent(server.id)}/metrics`));
      renderOverview();
    }).catch(() => {});
  }

  async function loadOverviewTelemetry() {
    const running = state.servers.filter((server) => server.status === 'running');
    const results = await Promise.allSettled(running.map(async (server) => [server.id, await api(`/servers/${encodeURIComponent(server.id)}/metrics`)]));
    state.serverMetrics = new Map(results.filter((result) => result.status === 'fulfilled').map((result) => result.value));
    if (state.route === 'overview') renderOverview();
  }

  function emptyState(container, title, message) {
    clear(container);
    const wrapper = make('div', 'empty-state');
    wrapper.append(make('h3', '', title), make('p', '', message));
    container.append(wrapper);
  }

  function checkItem(label, kind = 'neutral') {
    const item = make('div', `check-item ${kind}`);
    item.append(make('span', 'check-icon', kind === 'success' ? '✓' : '·'), make('span', '', label));
    return item;
  }

  function renderServers() {
    const list = $('#server-list');
    clear(list);
    if (!state.servers.length) emptyState(list, 'No servers', 'Create one to get started.');
    else state.servers.forEach((server) => list.append(createServerRow(server)));
    renderWorkspace();
  }

  function selectedServer() {
    return state.servers.find((server) => server.id === state.selectedServerId) || null;
  }

  function explicitServerCapability(server, names) {
    const capabilities = server?.capabilities;
    if (Array.isArray(capabilities)) return names.some((name) => capabilities.includes(name));
    if (!capabilities || typeof capabilities !== 'object') return null;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(capabilities, name)) return Boolean(capabilities[name]);
    }
    return null;
  }

  function serverCapabilities(server) {
    const canOwn = state.principal?.role === 'owner' || server?.ownerId === state.principal?.id;
    const level = canOwn ? 'manage' : server?.access;
    const explicitManage = explicitServerCapability(server, ['manage', 'server.files', 'files', 'server.backup', 'backups', 'content']);
    const explicitOperate = explicitServerCapability(server, ['operate', 'server.control', 'control', 'server.command', 'command']);
    const canManage = canOwn || (explicitManage ?? level === 'manage');
    const canOperate = canManage || (explicitOperate ?? level === 'operate');
    return { canOwn, canManage, canOperate };
  }

  function canCreateServers() {
    return ['owner', 'member', 'operator'].includes(state.principal?.role);
  }

  function configureWorkspaceTabs(workspace, server) {
    const idPrefix = `server-${String(server.id).replace(/[^a-z0-9_-]/gi, '-')}`;
    $$('.tabs [role="tab"]', workspace).forEach((tab) => {
      const panel = $(`.workspace-panel[data-name="${tab.dataset.panel}"]`, workspace);
      if (!panel) return;
      tab.id = `${idPrefix}-tab-${tab.dataset.panel}`;
      panel.id = `${idPrefix}-panel-${tab.dataset.panel}`;
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('aria-labelledby', tab.id);
    });
  }

  function renderWorkspace() {
    const workspace = $('#server-workspace');
    const server = selectedServer();
    if (!server) {
      emptyState(workspace, 'Select a server', 'Choose a server to inspect its health, files, backups, and content.');
      return;
    }
    const fragment = $('#workspace-template').content.cloneNode(true);
    clear(workspace);
    workspace.append(fragment);
    $('.server-name', workspace).textContent = server.name;
    $('.server-meta', workspace).textContent = `${server.software} ${server.version} · ${server.memory} RAM`;
    const status = statusClass(server.status);
    if (status) $('.server-status-dot', workspace).classList.add(status);
    const { canOwn, canManage, canOperate } = serverCapabilities(server);
    $$('.owner-control', workspace).forEach((node) => { node.hidden = !canManage; });
    $$('.server-owner-control', workspace).forEach((node) => { node.hidden = !canOwn; });
    $$('[data-requires-manage]', workspace).forEach((node) => { node.hidden = !canManage; });
    $$('[data-action="start"], [data-action="stop"], [data-action="restart"]', workspace).forEach((node) => { node.hidden = !canOperate; });
    const command = $('.command-form', workspace);
    if (!canOperate) {
      command.hidden = true;
    }
    configureWorkspaceTabs(workspace, server);
    bindWorkspace(workspace, server, { canOwn, canManage, canOperate });
    const requestedTab = state.serverTabs.get(server.id) || 'connection';
    const requestedControl = $(`.tabs [data-panel="${requestedTab}"]`, workspace);
    const tab = requestedControl && !requestedControl.hidden ? requestedTab : 'connection';
    activatePanel(workspace, server, tab);
  }

  function bindWorkspace(workspace, server, permissions) {
    workspace.dataset.canManage = String(permissions.canManage);
    upgradeRefreshButtons(workspace);
    $$('.tabs [role="tab"]', workspace).forEach((button) => button.addEventListener('click', () => activatePanel(workspace, server, button.dataset.panel)));
    $('.tabs', workspace).addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = $$('.tabs [role="tab"]', workspace).filter((tab) => !tab.hidden && !tab.disabled);
      const current = tabs.indexOf(event.target.closest('[role="tab"]'));
      if (current < 0 || !tabs.length) return;
      event.preventDefault();
      let index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : current + (event.key === 'ArrowRight' ? 1 : -1);
      index = (index + tabs.length) % tabs.length;
      tabs[index].focus();
      activatePanel(workspace, server, tabs[index].dataset.panel);
    });
    $$('.route-action', workspace).forEach((button) => button.addEventListener('click', () => navigate(button.dataset.route)));
    $$('[data-action]', workspace).forEach((button) => button.addEventListener('click', async () => {
      const action = button.dataset.action;
      if (['start', 'stop', 'restart', 'rebuild', 'delete'].includes(action)) return handleServerAction(server, action, button);
      if (action === 'logs') return loadLogs(server, workspace, button);
      if (action === 'logs-range') {
        try { return loadLogs(server, workspace, button, selectedLogRange(workspace)); } catch (error) { notify(error.message, 'error'); }
      }
      if (action === 'metrics') return loadMetrics(server, workspace, button);
      if (action === 'files') return loadFiles(server, workspace, button);
      if (action === 'upload') return $('.upload-input', workspace).click();
      if (action === 'new-folder') return createFolder(server, workspace, button);
      if (action === 'save-file') return saveSelectedFile(server, workspace, button);
      if (action === 'download-file') return downloadSelectedFile(server, workspace, button);
      if (action === 'rename-file') return renameSelectedFile(server, workspace, button);
      if (action === 'delete-file') return deleteSelectedFile(server, workspace, button);
      if (action === 'backup') return createBackup(server, workspace, button);
      if (action === 'export-backup') return exportBackup(server, workspace, button);
      if (action === 'import-backup') return $('.backup-upload-input', workspace).click();
      if (action === 'backups') return loadBackups(server, workspace, button);
      if (action === 'content-refresh') return loadInstalledContent(server, workspace, button);
    }));
    $('.connection-check', workspace).addEventListener('click', (event) => loadConnection(server, workspace, event.currentTarget));
    $('.copy-public', workspace).addEventListener('click', () => copyText($('.connection-public', workspace).textContent));
    $('.copy-lan', workspace).addEventListener('click', () => copyText($('.connection-lan', workspace).textContent));
    $('.command-form', workspace).addEventListener('submit', (event) => sendCommand(event, server, workspace));
    $('.console-search', workspace).addEventListener('input', () => renderConsoleLogs(workspace));
    $('.console-range', workspace).addEventListener('change', (event) => {
      $('.console-time-window', workspace).hidden = event.currentTarget.value !== 'custom';
    });
    $$('.console-filters [data-console-filter]', workspace).forEach((button) => button.addEventListener('click', () => {
      $$('.console-filters [data-console-filter]', workspace).forEach((filter) => filter.classList.toggle('active', filter === button));
      workspace.dataset.consoleFilter = button.dataset.consoleFilter;
      renderConsoleLogs(workspace);
    }));
    $('.upload-input', workspace).addEventListener('change', (event) => uploadFiles(event, server, workspace));
    $('.backup-upload-input', workspace).addEventListener('change', (event) => importBackup(event, server, workspace));
    if (permissions.canOwn) $('.share-form', workspace).addEventListener('submit', (event) => grantServerAccess(event, server, workspace));
    if (!permissions.canManage) {
      $$('[data-action="upload"], [data-action="new-folder"], [data-action="save-file"], [data-action="rename-file"], [data-action="delete-file"]', workspace)
        .forEach((button) => { button.disabled = true; });
    }
  }

  function activatePanel(workspace, server, name) {
    const selectedTab = $(`.tabs [data-panel="${name}"]`, workspace);
    if (!selectedTab || selectedTab.hidden || selectedTab.disabled) return;
    state.serverTabs.set(server.id, name);
    $$('.tabs [role="tab"]', workspace).forEach((button) => {
      const active = button.dataset.panel === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $$('.workspace-panel', workspace).forEach((panel) => {
      const active = panel.dataset.name === name;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
      panel.setAttribute('aria-hidden', String(!active));
    });
    if (name === 'connection') loadConnection(server, workspace).catch(() => {});
    if (name === 'console') loadLogs(server, workspace).catch(() => {});
    if (name === 'monitoring') loadMetrics(server, workspace).catch(() => {});
    if (name === 'files') loadFiles(server, workspace).catch(() => {});
    if (name === 'backups') loadBackups(server, workspace).catch(() => {});
    if (name === 'content') loadInstalledContent(server, workspace).catch(() => {});
    if (name === 'sharing') loadServerAccess(server, workspace).catch(() => {});
  }

  async function handleServerAction(server, action, button) {
    if (action === 'delete' && !confirm(`Delete ${server.name}? Backups and server files may also be removed.`)) return;
    if (action === 'rebuild' && !confirm('Repair the runtime container? Persistent Minecraft files are kept.')) return;
    await withBusy(button, async () => {
      if (action === 'delete') await api(`/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' });
      else await api(`/servers/${encodeURIComponent(server.id)}/${action}`, { method: 'POST' });
      await reloadServers();
      notify(action === 'delete' ? 'Server deleted.' : `${server.name}: ${action} completed.`, 'success');
    }).catch(() => {});
  }

  async function reloadServers() {
    state.servers = unwrapList(await api('/servers'), 'servers', 'items');
    if (!state.servers.some((server) => server.id === state.selectedServerId)) state.selectedServerId = state.servers[0]?.id || null;
    hydrateCatalogServerSelect();
    renderCurrentRoute();
    loadOverviewTelemetry().catch(() => {});
  }

  async function loadConnection(server, workspace, button) {
    const publicNode = $('.connection-public', workspace);
    const lanNode = $('.connection-lan', workspace);
    publicNode.textContent = server.connectionAddress || 'Detecting…';
    lanNode.textContent = 'Detecting…';
    try {
      const result = await (button ? withBusy(button, () => api(`/servers/${encodeURIComponent(server.id)}/connectivity`, { method: 'POST' })) : api(`/servers/${encodeURIComponent(server.id)}/connectivity`));
      if (!document.body.contains(workspace) || selectedServer()?.id !== server.id) return;
      publicNode.textContent = result.public?.joinAddress || server.connectionAddress || 'Not detected';
      lanNode.textContent = result.lan?.joinAddress || 'Not detected';
      state.detectedSshHost = result.public?.host || result.public?.ip || result.lan?.ip || state.detectedSshHost;
      renderSshCommands();
      $('.connection-port', workspace).textContent = result.port?.external || server.port || '—';
      $('.connection-protocol', workspace).textContent = result.port?.protocol || 'TCP';
      const portState = result.public?.portState || 'not-confirmed';
      $('.connection-public-state', workspace).textContent = portState === 'publicly-reachable'
        ? 'Publicly reachable'
        : result.public?.probeFromHost ? 'Route answered locally' : 'Not confirmed';
      const statuses = $('.connection-statuses', workspace);
      clear(statuses);
      (result.statuses || []).forEach((status) => statuses.append(checkItem(status.label, status.state)));
      if (!(result.statuses || []).length) statuses.append(checkItem('Connectivity check returned no status details'));
      const guidance = $('.cloud-guidance span', workspace);
      const guidanceTitle = $('.cloud-guidance strong', workspace);
      if (result.mode === 'cloud') {
        const port = result.cloud?.inboundPort || result.port?.external || server.port;
        guidanceTitle.textContent = 'Cloud firewall rule';
        guidance.textContent = `Allow inbound TCP ${port} to this VM in Oracle or your cloud firewall. The private VNIC address is ${result.cloud?.privateIp || 'shown above'}; friends use the public address.`;
      } else {
        const port = result.forwarding?.externalPort || server.port;
        guidanceTitle.textContent = 'Router port-forward rule';
        guidance.textContent = `Forward TCP ${port} to ${result.forwarding?.internalIp || 'this host'}:${result.forwarding?.internalPort || port}. A running container alone does not prove public reachability.`;
      }
    } catch (error) {
      if (button) notify(error.message, 'error');
      $('.connection-public-state', workspace).textContent = 'Check unavailable';
    }
  }

  function selectedLogRange(workspace) {
    const range = $('.console-range', workspace).value;
    if (range === 'recent') return { tail: '500', label: 'recent 500 lines' };
    if (range === 'start') return { tail: 'all', since: 'start', label: 'since server start' };
    const since = $('.console-since', workspace).value;
    const until = $('.console-until', workspace).value;
    if (!since) throw new ApiError('Choose a start time for the custom log window.', 400);
    return { tail: 'all', since: new Date(since).toISOString(), until: until ? new Date(until).toISOString() : '', label: 'custom time window' };
  }

  async function loadLogs(server, workspace, button, requestedRange = null) {
    const terminal = $('.terminal', workspace);
    const range = requestedRange || { tail: workspace.dataset.logTail || '500', since: workspace.dataset.logSince || '', until: workspace.dataset.logUntil || '', label: workspace.dataset.logRangeLabel || 'recent 500 lines' };
    const params = new URLSearchParams({ tail: range.tail });
    if (range.since) params.set('since', range.since);
    if (range.until) params.set('until', range.until);
    try {
      const result = await (button ? withBusy(button, () => api(`/servers/${encodeURIComponent(server.id)}/logs?${params}`)) : api(`/servers/${encodeURIComponent(server.id)}/logs?${params}`));
      workspace.dataset.logTail = range.tail;
      workspace.dataset.logSince = range.since || '';
      workspace.dataset.logUntil = range.until || '';
      workspace.dataset.logRangeLabel = range.label;
      workspace.consoleLogs = result?.logs || '';
      renderConsoleLogs(workspace);
    } catch (error) { terminal.textContent = `Unable to load logs: ${error.message}`; }
  }

  function renderConsoleLogs(workspace) {
    const terminal = $('.terminal', workspace);
    const lines = String(workspace.consoleLogs || '').split('\n').filter(Boolean);
    const query = $('.console-search', workspace).value.trim().toLowerCase();
    const filter = workspace.dataset.consoleFilter || 'all';
    const matchFilter = consoleLogFilters[filter] || consoleLogFilters.all;
    const visible = lines.filter((line) => matchFilter(line) && (!query || line.toLowerCase().includes(query)));
    terminal.textContent = visible.join('\n') || 'No matching log output.';
    $('.console-summary', workspace).textContent = `${visible.length.toLocaleString()} of ${lines.length.toLocaleString()} lines · ${workspace.dataset.logRangeLabel || 'recent 500 lines'}`;
    terminal.scrollTop = query || filter !== 'all' ? 0 : terminal.scrollHeight;
  }

  const consoleLogFilters = {
    all: () => true,
    errors: (line) => /\b(error|exception|failed|warn|severe|stack trace)\b/i.test(line),
    players: (line) => /\b(joined the game|left the game|logged in|lost connection|uuid of player|player)\b/i.test(line),
    operator: (line) => /\b(op|deop|operator|whitelist|ban|pardon|kick)\b|made .+ an operator|removed .+ from operators/i.test(line),
    give: (line) => /issued server command:.*\/give\b|\/give\b/i.test(line),
    gamemode: (line) => /issued server command:.*\/gamemode\b|\/gamemode\b|set own game mode|set the game mode/i.test(line),
    admin: (line) => /issued server command:.*\/(op|deop|give|gamemode|effect|enchant|summon|teleport|tp|kill|weather|time|difficulty)\b|\/(op|deop|give|gamemode|effect|enchant|summon|teleport|tp|kill|weather|time|difficulty)\b/i.test(line)
  };

  async function sendCommand(event, server, workspace) {
    event.preventDefault();
    const input = event.currentTarget.elements.command;
    const command = input.value.trim();
    if (!command) return;
    const button = $('button', event.currentTarget);
    await withBusy(button, async () => {
      await api(`/servers/${encodeURIComponent(server.id)}/command`, { method: 'POST', json: { command } });
      input.value = '';
      await loadLogs(server, workspace);
    }).catch(() => {});
  }

  async function loadMetrics(server, workspace, button) {
    try {
      const result = await (button ? withBusy(button, () => api(`/servers/${encodeURIComponent(server.id)}/metrics`)) : api(`/servers/${encodeURIComponent(server.id)}/metrics`));
      $('.cpu', workspace).textContent = result.CPUPerc || result.cpu || '—';
      $('.memory', workspace).textContent = result.MemUsage || result.memory || '—';
      $('.players', workspace).textContent = result.playersOnline === null || result.playersOnline === undefined ? 'Unavailable' : `${result.playersOnline} / ${result.maxPlayers ?? '—'}`;
      $('.player-names', workspace).textContent = result.players?.length ? result.players.join(', ') : result.playersOnline === 0 ? 'No players online' : 'Player list unavailable';
      $('.uptime', workspace).textContent = result.uptimeSeconds === null || result.uptimeSeconds === undefined ? 'Unavailable' : formatDuration(result.uptimeSeconds);
      $('.network', workspace).textContent = result.NetIO || result.network || '—';
      $('.block', workspace).textContent = result.BlockIO || result.block || '—';
    } catch (error) {
      $$('.cpu, .memory, .players, .uptime, .network, .block', workspace).forEach((node) => { node.textContent = 'Unavailable'; });
      if (button) notify(error.message, 'error');
    }
  }

  async function loadInstalledContent(server, workspace, button) {
    const list = $('.installed-content', workspace);
    list.replaceChildren(make('div', 'loading-row', 'Loading installed content…'));
    try {
      const items = unwrapList(await (button
        ? withBusy(button, () => api(`/servers/${encodeURIComponent(server.id)}/content`))
        : api(`/servers/${encodeURIComponent(server.id)}/content`)), 'items', 'content');
      clear(list);
      if (!items.length) {
        emptyState(list, 'No managed content found', 'Install a compatible mod or plugin from the catalog, or upload a JAR through Files.');
        return;
      }
      items.forEach((item) => {
        const row = make('div', 'member-row');
        const details = make('div');
        details.append(make('strong', '', item.name), make('small', '', `${item.kind || 'content'} · ${formatBytes(item.size)} · ${item.path}`));
        const name = make('div', 'member-name');
        const active = member.status !== 'disabled';
        const presence = make('span', `member-presence ${active ? 'active' : 'disabled'}`);
        presence.setAttribute('role', 'img');
        presence.setAttribute('aria-label', active ? 'Active account' : 'Disabled account');
        name.append(presence, make('strong', '', member.displayName || member.username));
        $('strong', details)?.remove();
        $('small', details).textContent = `${member.role} · ${maxServers} · ${memory}`;
        details.prepend(name);
        const actions = make('div', 'action-row');
        actions.append(make('span', `status-pill ${item.enabled ? 'success' : 'warning'}`, item.enabled ? 'Enabled' : 'Disabled'));
        const toggle = make('button', 'secondary small', item.enabled ? 'Disable' : 'Enable');
        toggle.type = 'button';
        toggle.addEventListener('click', () => withBusy(toggle, async () => {
          await api(`/servers/${encodeURIComponent(server.id)}/content`, { method: 'PATCH', json: { path: item.path, enabled: !item.enabled } });
          await loadInstalledContent(server, workspace);
          notify(`${item.name} ${item.enabled ? 'disabled' : 'enabled'}. Restart ${server.name} to apply the change.`, 'success', 7000);
        }).catch(() => {}));
        const remove = make('button', 'danger small', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          if (!confirm(`Remove ${item.name} from ${server.name}? This deletes the installed file.`)) return;
          withBusy(remove, async () => {
            await api(`/servers/${encodeURIComponent(server.id)}/content?path=${encodeURIComponent(item.path)}`, { method: 'DELETE' });
            await loadInstalledContent(server, workspace);
            notify(`${item.name} removed. Restart ${server.name} to apply the change.`, 'success', 7000);
          }).catch(() => {});
        });
        actions.append(toggle, remove);
        row.append(details, actions);
        list.append(row);
      });
    } catch (error) {
      list.replaceChildren(make('div', 'loading-row', `Unable to load installed content: ${error.message}`));
    }
  }

  function currentFilePath(server) { return state.filePaths.get(server.id) || '.'; }
  function relativeJoin(directory, name) { return directory === '.' ? name : `${directory.replace(/\/$/, '')}/${name}`; }
  function parentPath(value) {
    const parts = String(value || '.').split('/').filter((part) => part && part !== '.');
    parts.pop();
    return parts.length ? parts.join('/') : '.';
  }

  function renderBreadcrumb(server, workspace) {
    const breadcrumb = $('.breadcrumb', workspace);
    clear(breadcrumb);
    const root = make('button', '', 'data');
    root.type = 'button';
    root.addEventListener('click', () => { state.filePaths.set(server.id, '.'); loadFiles(server, workspace); });
    breadcrumb.append(root);
    let cursor = '';
    currentFilePath(server).split('/').filter((part) => part && part !== '.').forEach((part) => {
      breadcrumb.append(make('span', 'muted', '/'));
      cursor = cursor ? `${cursor}/${part}` : part;
      const target = cursor;
      const button = make('button', '', part);
      button.type = 'button';
      button.addEventListener('click', () => { state.filePaths.set(server.id, target); loadFiles(server, workspace); });
      breadcrumb.append(button);
    });
  }

  async function loadFiles(server, workspace, button) {
    const directory = currentFilePath(server);
    renderBreadcrumb(server, workspace);
    const table = $('.file-table', workspace);
    table.replaceChildren(make('div', 'loading-row', 'Loading files…'));
    try {
      const result = await (button ? withBusy(button, () => api(`/servers/${encodeURIComponent(server.id)}/files?path=${encodeURIComponent(directory)}`)) : api(`/servers/${encodeURIComponent(server.id)}/files?path=${encodeURIComponent(directory)}`));
      const entries = unwrapList(result, 'items', 'files').sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : 1);
      state.currentFiles.set(server.id, entries);
      clear(table);
      if (directory !== '.') {
        const up = make('button', 'file-row');
        up.type = 'button';
        up.append(make('span', '', '↰'), make('span', '', 'Parent folder'), make('small', '', ''));
        up.addEventListener('click', () => { state.filePaths.set(server.id, parentPath(directory)); state.selectedFiles.delete(server.id); loadFiles(server, workspace); });
        table.append(up);
      }
      if (!entries.length && directory === '.') table.append(make('div', 'loading-row', 'This folder is empty.'));
      entries.forEach((entry) => {
        const row = make('button', `file-row${state.selectedFiles.get(server.id)?.path === entry.path ? ' active' : ''}`);
        row.type = 'button';
        row.append(make('span', '', entry.type === 'directory' ? '▱' : '·'), make('span', '', entry.name), make('small', '', entry.type === 'directory' ? 'Folder' : formatBytes(entry.size)));
        row.addEventListener('click', () => entry.type === 'directory' ? openDirectory(server, workspace, entry.path) : selectFile(server, workspace, entry));
        table.append(row);
      });
      syncFileInspector(server, workspace);
    } catch (error) {
      table.replaceChildren(make('div', 'loading-row', `Unable to load files: ${error.message}`));
    }
  }

  function openDirectory(server, workspace, path) {
    state.filePaths.set(server.id, path);
    state.selectedFiles.delete(server.id);
    loadFiles(server, workspace);
  }

  async function selectFile(server, workspace, entry) {
    state.selectedFiles.set(server.id, { ...entry, editable: false, previewPending: true });
    syncFileInspector(server, workspace);
    $$('.file-row', workspace).forEach((row) => row.classList.toggle('active', $('span:nth-child(2)', row)?.textContent === entry.name));
    const editor = $('.file-editor', workspace);
    editor.value = '';
    editor.disabled = true;
    try {
      const result = await api(`/servers/${encodeURIComponent(server.id)}/file?path=${encodeURIComponent(entry.path)}`);
      if (state.selectedFiles.get(server.id)?.path !== entry.path) return;
      const editable = result?.editable !== false && typeof result?.content === 'string';
      state.selectedFiles.set(server.id, { ...entry, editable, previewPending: false });
      editor.value = editable ? result.content : '';
      editor.disabled = !editable;
      syncFileInspector(server, workspace);
    } catch (error) {
      state.selectedFiles.set(server.id, { ...entry, editable: false, previewPending: false });
      $('.editing-path', workspace).textContent = `${entry.path} · Preview unavailable (${error.message})`;
    }
  }

  function syncFileInspector(server, workspace) {
    const entry = state.selectedFiles.get(server.id);
    const description = !entry
      ? 'Select a text file to edit, or download any binary file.'
      : entry.previewPending
        ? `${entry.path} · Loading preview…`
        : entry.editable === false
          ? `${entry.path} · Binary or non-editable file · ${formatBytes(entry.size)}`
          : `${entry.path} · ${formatBytes(entry.size)}`;
    $('.editing-path', workspace).textContent = description;
    const editor = $('.file-editor', workspace);
    if (!entry) {
      editor.value = '';
      editor.disabled = true;
    }
    const canManage = workspace.dataset.canManage === 'true';
    $('[data-action="download-file"]', workspace).disabled = !entry;
    $('[data-action="save-file"]', workspace).disabled = !entry || entry.editable !== true || !canManage;
    $$('[data-action="rename-file"], [data-action="delete-file"]', workspace)
      .forEach((button) => { button.disabled = !entry || !canManage; });
  }

  async function uploadFiles(event, server, workspace) {
    const files = [...event.target.files];
    event.target.value = '';
    if (!files.length) return;
    const directory = currentFilePath(server);
    const existing = new Set((state.currentFiles.get(server.id) || []).map((entry) => entry.name.toLowerCase()));
    const replacements = files.filter((file) => existing.has(file.name.toLowerCase()));
    if (replacements.length && !confirm(`Replace ${replacements.length} existing file${replacements.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    const uploadButton = $('[data-action="upload"]', workspace);
    await withBusy(uploadButton, async () => {
      for (const file of files) {
        const target = relativeJoin(directory, file.name);
        const replace = existing.has(file.name.toLowerCase());
        await api(`/servers/${encodeURIComponent(server.id)}/files/upload?path=${encodeURIComponent(target)}&replace=${replace}`, { method: 'PUT', body: file });
      }
      await loadFiles(server, workspace);
      notify(`${files.length} file${files.length === 1 ? '' : 's'} uploaded. Restart the server after replacing JAR or pack files.`, 'success', 7000);
    }).catch(() => {});
  }

  async function createFolder(server, workspace, button) {
    const name = prompt('Folder name');
    if (!name) return;
    const target = relativeJoin(currentFilePath(server), name.trim());
    await withBusy(button, async () => {
      await api(`/servers/${encodeURIComponent(server.id)}/directories`, { method: 'POST', json: { path: target } });
      await loadFiles(server, workspace);
    }).catch(() => {});
  }

  async function saveSelectedFile(server, workspace, button) {
    const entry = state.selectedFiles.get(server.id);
    if (!entry || entry.editable !== true) return notify('This file is not editable in the dashboard. Download it instead.', 'error');
    await withBusy(button, async () => {
      await api(`/servers/${encodeURIComponent(server.id)}/file`, { method: 'PUT', json: { path: entry.path, content: $('.file-editor', workspace).value } });
      notify(`${entry.name} saved. Some configuration changes require a restart.`, 'success');
    }).catch(() => {});
  }

  async function downloadSelectedFile(server, workspace, button) {
    const entry = state.selectedFiles.get(server.id);
    if (!entry) return;
    await withBusy(button, async () => {
      const response = await api(`/servers/${encodeURIComponent(server.id)}/files/download?path=${encodeURIComponent(entry.path)}`, { response: 'raw' });
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = entry.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }).catch(() => {});
  }

  async function renameSelectedFile(server, workspace, button) {
    const entry = state.selectedFiles.get(server.id);
    if (!entry) return;
    const name = prompt('New file name or relative path', entry.name);
    if (!name || name === entry.name) return;
    const destination = relativeJoin(parentPath(entry.path), name.trim());
    const replacement = (state.currentFiles.get(server.id) || []).some((item) => item.path === destination);
    if (replacement && !confirm(`Replace ${destination}? This cannot be undone.`)) return;
    await withBusy(button, async () => {
      await api(`/servers/${encodeURIComponent(server.id)}/files/rename`, { method: 'POST', json: { path: entry.path, destination, replace: replacement } });
      state.selectedFiles.delete(server.id);
      await loadFiles(server, workspace);
    }).catch(() => {});
  }

  async function deleteSelectedFile(server, workspace, button) {
    const entry = state.selectedFiles.get(server.id);
    if (!entry || !confirm(`Delete ${entry.path}? This cannot be undone.`)) return;
    await withBusy(button, async () => {
      await api(`/servers/${encodeURIComponent(server.id)}/files/entry?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
      state.selectedFiles.delete(server.id);
      await loadFiles(server, workspace);
    }).catch(() => {});
  }

  async function loadBackups(server, workspace, button) {
    const list = $('.backup-list', workspace);
    list.replaceChildren(make('div', 'loading-row', 'Loading backups…'));
    try {
      const result = await (button ? withBusy(button, () => api(`/servers/${encodeURIComponent(server.id)}/backups`)) : api(`/servers/${encodeURIComponent(server.id)}/backups`));
      const backups = unwrapList(result, 'backups', 'items');
      clear(list);
      if (!backups.length) list.append(make('div', 'loading-row', 'No backups yet.'));
      backups.forEach((backup) => {
        const name = typeof backup === 'string' ? backup : backup.name;
        const row = make('div', 'backup-row');
        const details = make('div');
        const summary = typeof backup === 'object'
          ? [backup.size ? formatBytes(backup.size) : 'Compressed snapshot', backup.createdAt ? formatDate(backup.createdAt) : null].filter(Boolean).join(' · ')
          : 'Compressed snapshot';
        details.append(make('strong', '', name), make('small', 'muted', summary));
        const actions = make('div', 'action-row');
        const download = make('button', 'secondary small', 'Download');
        download.addEventListener('click', () => downloadBackup(server, name, download));
        const restore = make('button', 'secondary small', 'Restore');
        restore.addEventListener('click', async () => {
          if (!confirm(`Restore ${name}? The server will stop and current files will be replaced.`)) return;
          await withBusy(restore, async () => {
            await api(`/servers/${encodeURIComponent(server.id)}/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' });
            await reloadServers();
            const updated = state.servers.find((item) => item.id === server.id);
            const stopped = !updated || updated.status !== 'running';
            notify(stopped ? `Backup restored. ${server.name} is stopped; use Start when you are ready.` : `Backup restored. ${server.name} is running.`, 'success', 8000);
          }).catch(() => {});
        });
        const remove = make('button', 'danger small', 'Delete');
        remove.addEventListener('click', async () => {
          if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
          await withBusy(remove, async () => {
            await api(`/servers/${encodeURIComponent(server.id)}/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
            await loadBackups(server, workspace);
            notify('Backup deleted.', 'success');
          }).catch(() => {});
        });
        actions.append(download, restore, remove);
        row.append(details, actions);
        list.append(row);
      });
    } catch (error) { list.replaceChildren(make('div', 'loading-row', `Unable to load backups: ${error.message}`)); }
  }

  async function createBackup(server, workspace, button) {
    await withBusy(button, async () => {
      await api(`/servers/${encodeURIComponent(server.id)}/backups`, { method: 'POST' });
      await loadBackups(server, workspace);
      notify('Backup created.', 'success');
    }).catch(() => {});
  }

  async function downloadBackupArchive(server, name) {
    const response = await api(`/servers/${encodeURIComponent(server.id)}/backups/${encodeURIComponent(name)}/download`, { response: 'raw' });
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadBackup(server, name, button) {
    await withBusy(button, async () => {
      await downloadBackupArchive(server, name);
      notify('Backup download started.', 'success');
    }).catch(() => {});
  }

  async function exportBackup(server, workspace, button) {
    await withBusy(button, async () => {
      const backup = await api(`/servers/${encodeURIComponent(server.id)}/backups`, { method: 'POST' });
      await downloadBackupArchive(server, backup.name);
      await loadBackups(server, workspace);
      notify('Transfer archive created and downloaded.', 'success');
    }).catch(() => {});
  }

  async function importBackup(event, server, workspace) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!/\.tar\.gz$/i.test(file.name)) {
      notify('Choose a .tar.gz transfer archive.', 'error');
      return;
    }
    const button = $('[data-action="import-backup"]', workspace);
    await withBusy(button, async () => {
      await api(`/servers/${encodeURIComponent(server.id)}/backups/import`, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': 'application/gzip' }
      });
      await loadBackups(server, workspace);
      notify('Game save imported. Select Restore when you are ready.', 'success', 7000);
    }).catch(() => {});
  }

  async function loadServerAccess(server, workspace) {
    const principalSelect = $('.share-principal', workspace);
    const list = $('.grant-list', workspace);
    list.replaceChildren(make('div', 'loading-row', 'Loading server access…'));
    try {
      const [candidateResult, grantResult] = await Promise.all([
        api(`/servers/${encodeURIComponent(server.id)}/share-candidates`),
        api(`/servers/${encodeURIComponent(server.id)}/grants`)
      ]);
      const candidates = unwrapList(candidateResult, 'principals', 'items');
      const grants = unwrapList(grantResult, 'grants', 'items');
      const grantedIds = new Set(grants.map((grant) => grant.principalId));
      clear(principalSelect);
      candidates.filter((candidate) => !grantedIds.has(candidate.id)).forEach((candidate) => {
        const option = make('option', '', `${candidate.displayName || candidate.username} · ${candidate.role}`);
        option.value = candidate.id;
        principalSelect.append(option);
      });
      if (!principalSelect.options.length) {
        const option = make('option', '', candidates.length ? 'Everyone listed already has access' : 'Create a friend invite first');
        option.value = '';
        principalSelect.append(option);
      }
      principalSelect.disabled = !candidates.length || candidates.every((candidate) => grantedIds.has(candidate.id));
      $('.share-form button', workspace).disabled = principalSelect.disabled;
      clear(list);
      if (!grants.length) list.append(make('div', 'loading-row', 'Only the server owner can access this server.'));
      grants.forEach((grant) => {
        const row = make('div', 'member-row');
        const details = make('div');
        const account = grant.principal || {};
        details.append(make('strong', '', account.displayName || account.username || grant.principalId), make('small', '', `${grant.level} access · ${account.role || 'account'}`));
        const revoke = make('button', 'secondary small', 'Revoke');
        revoke.type = 'button';
        revoke.addEventListener('click', async () => {
          if (!confirm(`Remove ${account.displayName || account.username || 'this account'} from ${server.name}?`)) return;
          await withBusy(revoke, async () => {
            await api(`/servers/${encodeURIComponent(server.id)}/grants/${encodeURIComponent(grant.principalId)}`, { method: 'DELETE' });
            await loadServerAccess(server, workspace);
          }).catch(() => {});
        });
        row.append(details, revoke);
        list.append(row);
      });
    } catch (error) {
      list.replaceChildren(make('div', 'loading-row', `Unable to load server access: ${error.message}`));
    }
  }

  async function grantServerAccess(event, server, workspace) {
    event.preventDefault();
    const principalId = $('.share-principal', workspace).value;
    const level = $('.share-level', workspace).value;
    if (!principalId) return;
    const button = $('button', event.currentTarget);
    await withBusy(button, async () => {
      await api(`/servers/${encodeURIComponent(server.id)}/grants`, { method: 'POST', json: { principalId, level } });
      await loadServerAccess(server, workspace);
      notify('Server access updated.', 'success');
    }).catch(() => {});
  }

  function hydrateCatalogControls() {
    const select = $('#create-software');
    const previous = select.value;
    clear(select);
    const software = unwrapList(state.catalog?.software || state.catalog, 'software', 'items');
    (software.length ? software : [
      { id: 'PAPER', name: 'Paper' }, { id: 'VANILLA', name: 'Vanilla' }, { id: 'PURPUR', name: 'Purpur' },
      { id: 'FABRIC', name: 'Fabric' }, { id: 'FORGE', name: 'Forge' }, { id: 'NEOFORGE', name: 'NeoForge' }
    ]).forEach((item) => {
      const option = make('option', '', item.name || item.id);
      option.value = item.id;
      if (item.recommended) option.textContent += ' · recommended';
      select.append(option);
    });
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    hydrateCatalogServerSelect();
  }

  function setCatalogControlsEnabled(enabled) {
    $('#catalog-query').disabled = !enabled;
    $('#catalog-type').disabled = !enabled;
    $('#catalog-search').disabled = !enabled;
    $$('#provider-tabs [role="tab"]').forEach((button) => { button.disabled = !enabled; });
  }

  function hydrateCatalogServerSelect() {
    const select = $('#catalog-server');
    const previous = select.value;
    clear(select);
    const manageable = state.servers.filter((server) => serverCapabilities(server).canManage);
    const canCreate = canCreateServers();
    if (!manageable.length && !canCreate) {
      const option = make('option', '', state.servers.length ? 'No servers you can manage' : 'Create a server first');
      option.value = '';
      select.append(option);
      select.disabled = true;
      setCatalogControlsEnabled(false);
      if (state.route === 'content') emptyState($('#catalog-results'), 'Manage access required', 'Only a server owner or manager can install files, backups, or catalog content.');
      return;
    }
    select.disabled = false;
    setCatalogControlsEnabled(true);
    if (canCreate) {
      const option = make('option', '', 'Create a matching server from a modpack');
      option.value = '';
      select.append(option);
    }
    manageable.forEach((server) => {
      const option = make('option', '', `${server.name} · ${server.software} ${server.version}`);
      option.value = server.id;
      select.append(option);
    });
    if (manageable.some((server) => server.id === previous)) select.value = previous;
    else if (canCreate) select.value = '';
  }

  async function loadMinecraftVersions() {
    const software = $('#create-software').value || 'PAPER';
    const select = $('#create-version');
    const previous = select.value;
    const requestId = ++state.requests.minecraftVersions;
    select.disabled = true;
    select.replaceChildren(make('option', '', 'Loading exact versions…'));
    let failed = false;
    try {
      const result = await api(`/catalog/minecraft-versions?software=${encodeURIComponent(software)}`);
      if (requestId !== state.requests.minecraftVersions || $('#create-software').value !== software) return;
      const versions = unwrapList(result, 'versions', 'items');
      clear(select);
      versions.forEach((version) => {
        const option = make('option', '', version.label || version.id);
        option.value = version.id;
        if (version.stable === false || (version.type && version.type !== 'release')) option.textContent += ` · ${version.type || 'preview'}`;
        select.append(option);
      });
      if (!versions.length) {
        const fallback = make('option', '', 'Latest compatible release');
        fallback.value = 'LATEST';
        select.append(fallback);
      }
      if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    } catch (error) {
      if (requestId !== state.requests.minecraftVersions || $('#create-software').value !== software) return;
      failed = true;
      const fallback = make('option', '', 'Version catalog unavailable');
      fallback.value = '';
      select.replaceChildren(fallback);
      if (error.status !== 404) notify(`Version catalog: ${error.message}`, 'error');
    } finally {
      if (requestId !== state.requests.minecraftVersions || $('#create-software').value !== software) return;
      select.disabled = failed;
      if (!failed) await loadServerBuilds();
    }
  }

  async function loadServerBuilds() {
    const software = $('#create-software').value || 'PAPER';
    const version = $('#create-version').value || 'LATEST';
    const select = $('#create-build');
    const requestId = ++state.requests.builds;
    select.disabled = true;
    const automatic = make('option', '', 'Automatic stable build');
    automatic.value = '';
    select.replaceChildren(automatic);
    try {
      const result = await api(`/catalog/builds?software=${encodeURIComponent(software)}&minecraftVersion=${encodeURIComponent(version)}`);
      if (requestId !== state.requests.builds || $('#create-software').value !== software || ($('#create-version').value || 'LATEST') !== version) return;
      const builds = unwrapList(result, 'builds', 'items');
      builds.forEach((build) => {
        const option = make('option', '', build.label || build.id);
        option.value = build.id;
        if (build.channel && String(build.channel).toUpperCase() !== 'STABLE') option.textContent += ` · ${String(build.channel).toLowerCase()}`;
        select.append(option);
      });
      select.disabled = builds.length === 0;
    } catch (error) {
      if (requestId !== state.requests.builds || $('#create-software').value !== software || ($('#create-version').value || 'LATEST') !== version) return;
      select.disabled = true;
      if (error.status !== 404 && !String(error.message).includes('does not expose')) notify(`Build catalog: ${error.message}`, 'error');
    }
  }

  async function createServer(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const payload = {
      name: values.name,
      software: values.software,
      version: values.version,
      build: values.build || '',
      memory: values.memory,
      cpus: Number(values.cpus)
    };
    if (values.port) payload.port = Number(values.port);
    const button = $('button[type="submit"]', form);
    await withBusy(button, async () => {
      const server = await api('/servers', { method: 'POST', json: payload });
      await reloadServers();
      state.selectedServerId = server.id;
      navigate('servers');
      notify(`${server.name} was created and is starting.`, 'success');
    }).catch(() => {});
  }

  function providerLoader(server) {
    return ({ PAPER: 'paper', PURPUR: 'paper', FABRIC: 'fabric', FORGE: 'forge', NEOFORGE: 'neoforge' })[server?.software] || 'vanilla';
  }

  function activateProviderTab(button, runSearch = true) {
    if (!button || button.disabled) return;
    state.provider = button.dataset.provider;
    $$('#provider-tabs [role="tab"]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    });
    $('#catalog-results').setAttribute('aria-labelledby', button.id);
    if (state.provider === 'hangar') $('#catalog-type').value = 'plugin';
    if (runSearch) searchCatalog();
  }

  async function searchCatalog() {
    const server = state.servers.find((item) => item.id === $('#catalog-server').value);
    const query = $('#catalog-query').value.trim();
    const kind = $('#catalog-type').value;
    const provider = state.provider;
    const requestId = ++state.requests.catalogSearch;
    const results = $('#catalog-results');
    if (server && !serverCapabilities(server).canManage) return emptyState(results, 'Manage access required', 'This server does not allow file or content changes.');
    if (!server && !canCreateServers()) return emptyState(results, 'Choose a server', 'Choose the target server before selecting an exact install version.');
    if (!server && kind !== 'modpack') return emptyState(results, 'Choose Modpacks', 'Select a target server to browse plugins or mods, or choose Modpacks to create a matching server first.');
    if (server?.software === 'VANILLA') return notify('Vanilla servers cannot load plugins or mods. Create a Paper, Fabric, Forge, or NeoForge server first.', 'error');
    if (query.length < 2) return notify('Enter at least two search characters.', 'error');
    if (state.provider === 'hangar' && (!server || kind !== 'plugin')) return notify('Hangar provides Paper-compatible plugins for a selected server only.', 'error');
    results.replaceChildren(make('div', 'loading-row', `Searching ${state.provider === 'hangar' ? 'Hangar' : 'Modrinth'}…`));
    const params = new URLSearchParams({ query, kind, limit: '24' });
    if (provider === 'hangar') params.set('loader', providerLoader(server));
    try {
      const result = await api(`/catalog/providers/${provider}/search?${params}`);
      if (requestId !== state.requests.catalogSearch || state.provider !== provider || $('#catalog-server').value !== (server?.id || '')) return;
      renderCatalogResults(unwrapList(result, 'items', 'projects'), server);
    } catch (error) {
      if (requestId === state.requests.catalogSearch && state.provider === provider && $('#catalog-server').value === (server?.id || '')) emptyState(results, 'Catalog unavailable', error.message);
    }
  }

  function safeProviderUrl(value, provider) {
    try {
      const url = new URL(value);
      const allowed = provider === 'modrinth' ? ['modrinth.com', 'cdn.modrinth.com'] : ['hangar.papermc.io', 'hangarcdn.papermc.io'];
      return url.protocol === 'https:' && allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null;
    } catch { return null; }
  }

  function renderCatalogResults(items, server) {
    const results = $('#catalog-results');
    clear(results);
    if (!items.length) return emptyState(results, 'No results found', 'Try a different search or content type. Exact compatibility is checked when you choose a version.');
    items.forEach((project) => {
      const card = make('article', 'catalog-card');
      const head = make('div', 'catalog-card-head');
      const iconUrl = safeProviderUrl(project.iconUrl, project.provider || state.provider);
      const icon = iconUrl ? document.createElement('img') : make('span', 'catalog-icon', (project.name || '?').slice(0, 1).toUpperCase());
      if (iconUrl) {
        icon.className = 'catalog-icon';
        icon.src = iconUrl;
        icon.alt = '';
        icon.loading = 'lazy';
      }
      const siteUrl = safeProviderUrl(project.websiteUrl, project.provider || state.provider);
      const title = make('div');
      const heading = make('h3', '', project.name || project.slug || project.id);
      title.append(heading, make('small', 'muted', project.author ? `by ${project.author}` : project.provider || state.provider));
      head.append(icon, title);
      if (siteUrl) {
        const projectLink = make('a', 'catalog-project-link');
        projectLink.href = siteUrl;
        projectLink.target = '_blank';
        projectLink.rel = 'noreferrer';
        projectLink.setAttribute('aria-label', `Open ${project.name || project.slug || project.id} on its provider`);
        projectLink.append(head);
        card.append(projectLink);
      } else card.append(head);
      card.append(make('p', 'summary', project.summary || 'No project summary is available.'));
      const metadata = make('div', 'catalog-meta');
      metadata.append(make('span', 'tag', project.projectType || 'content'));
      if (project.downloads !== undefined) metadata.append(make('span', 'tag', `${formatNumber(project.downloads)} downloads`));
      (project.loaders || []).slice(0, 2).forEach((loader) => metadata.append(make('span', 'tag', loader)));
      const compatibility = projectCompatibility(project, server);
      metadata.append(make('span', `tag ${compatibility.state}`, compatibility.label));
      card.append(metadata);
      const actions = make('div', 'catalog-actions');
      if (siteUrl) {
        const link = make('a', 'catalog-provider-link');
        link.href = siteUrl;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.append(lucideIcon('external-link'), 'Open provider');
        actions.append(link);
      } else actions.append(make('span'));
      const creatingFromPack = !server && (project.provider || state.provider) === 'modrinth' && project.projectType === 'modpack';
      const choose = make('button', 'small', creatingFromPack ? 'Choose pack release' : compatibility.exact ? 'Choose compatible version' : 'Check exact versions');
      choose.disabled = server ? !serverCapabilities(server).canManage : !creatingFromPack;
      choose.addEventListener('click', () => openProjectVersions(project, server));
      actions.append(choose);
      card.append(actions);
      results.append(card);
    });
  }

  function projectCompatibility(project, server) {
    if (!server) return { exact: false, state: 'neutral', label: 'Choose a release to create a server' };
    const expectedVersion = String(server.version || '');
    const expectedLoader = String(providerLoader(server) || '').toLowerCase();
    const versions = (project.gameVersions || []).map((value) => String(value));
    const loaders = (project.loaders || []).map((value) => String(value).toLowerCase());
    const versionKnown = versions.length > 0;
    const loaderKnown = loaders.length > 0;
    const versionMatches = !versionKnown || versions.includes(expectedVersion);
    const loaderMatches = !loaderKnown || loaders.includes(expectedLoader);
    if (versionMatches && loaderMatches && versionKnown && loaderKnown) return { exact: true, state: 'compatible', label: `Matches ${expectedLoader} ${expectedVersion}` };
    if (!versionMatches) return { exact: false, state: 'incompatible', label: `Not listed for ${expectedVersion}` };
    if (!loaderMatches) return { exact: false, state: 'incompatible', label: `Not listed for ${expectedLoader}` };
    return { exact: false, state: 'neutral', label: 'Check exact versions' };
  }

  async function openProjectVersions(project, server) {
    if (server && !serverCapabilities(server).canManage) return notify('Manager access is required to install server content.', 'error');
    if (!server && (!canCreateServers() || (project.provider || state.provider) !== 'modrinth' || project.projectType !== 'modpack')) return notify('Choose a target server before viewing install versions.', 'error');
    const dialog = $('#version-dialog');
    const provider = project.provider || state.provider;
    const requestId = ++state.requests.projectVersions;
    $('#version-provider').textContent = provider;
    $('#version-project').textContent = project.name || project.slug || project.id;
    const list = $('#version-list');
    list.replaceChildren(make('div', 'loading-row', 'Loading pack versions…'));
    dialog.showModal();
    const params = new URLSearchParams({ limit: '25' });
    if (provider === 'hangar' && server) params.set('loader', providerLoader(server));
    try {
      const result = await api(`/catalog/providers/${provider}/projects/${encodeURIComponent(project.id)}/versions?${params}`);
      if (requestId !== state.requests.projectVersions || !dialog.open) return;
      const versions = unwrapList(result, 'items', 'versions');
      clear(list);
      if (!versions.length) list.append(make('div', 'loading-row', 'No versions were returned by this provider.'));
      versions.forEach((version) => {
        const row = make('div', 'version-row');
        const details = make('div');
        const label = version.versionNumber || version.name || version.id;
        const dependencyCount = (version.dependencies || []).filter((dependency) => dependency.required).length;
        const compatibility = projectCompatibility(version, server);
        details.append(make('strong', '', label), make('small', '', `${version.releaseChannel || 'release'} · ${(version.gameVersions || []).slice(0, 3).join(', ') || 'version not listed'} · ${compatibility.label}${dependencyCount ? ` · ${dependencyCount} required dependencies` : ''}`));
        const install = make('button', 'small', 'Install exact');
        install.disabled = !server || !compatibility.exact;
        install.addEventListener('click', () => installProjectVersion(project, version, server, install));
        const actions = make('div', 'action-row');
        actions.append(install);
        if (provider === 'modrinth' && isModpackRelease(version)) {
          const provision = make('button', 'secondary small', 'Create server + install pack');
          provision.addEventListener('click', () => showModpackProvision(project, version));
          actions.append(provision);
        }
        row.append(details, actions);
        list.append(row);
      });
    } catch (error) {
      if (requestId === state.requests.projectVersions && dialog.open) list.replaceChildren(make('div', 'loading-row', `Unable to load versions: ${error.message}`));
    }
  }

  function isModpackRelease(version) {
    return (version.files || []).some((file) => /\.mrpack$/i.test(String(file.filename || '')));
  }

  function modpackRuntimes(version) {
    const softwareByLoader = { fabric: 'FABRIC', forge: 'FORGE', neoforge: 'NEOFORGE' };
    const loaders = [...new Set((version.loaders || []).map((loader) => String(loader).toLowerCase()).filter((loader) => softwareByLoader[loader]))];
    const gameVersions = [...new Set((version.gameVersions || []).map((gameVersion) => String(gameVersion).trim()).filter(Boolean))];
    return loaders.flatMap((loader) => gameVersions.map((gameVersion) => ({ id: `${softwareByLoader[loader]}|${gameVersion}`, software: softwareByLoader[loader], gameVersion, loader })));
  }

  function suggestedModpackServerName(project) {
    const value = String(project.name || project.slug || 'Modpack server').replace(/[^a-zA-Z0-9 _.-]/g, '').replace(/\s+/g, ' ').trim();
    return (value || 'Modpack server').slice(0, 48);
  }

  function showModpackProvision(project, version) {
    const runtimes = modpackRuntimes(version);
    if (!runtimes.length) return notify('This Modrinth release does not publish a supported Fabric, Forge, or NeoForge runtime. Choose another pack version.', 'error');
    const dialog = $('#modpack-create-dialog');
    const form = $('#modpack-create-form');
    state.modpackProvision = { project, version, runtimes };
    $('#modpack-create-title').textContent = `Create ${project.name || project.id}`;
    $('#modpack-create-summary').textContent = `Release ${version.versionNumber || version.name || version.id}. Open MC Host will use the selected loader and Minecraft version, then install the verified pack.`;
    form.elements.name.value = suggestedModpackServerName(project);
    const runtimeSelect = form.elements.runtime;
    clear(runtimeSelect);
    runtimes.forEach((runtime) => {
      const option = make('option', '', `${runtime.software} · Minecraft ${runtime.gameVersion}`);
      option.value = runtime.id;
      runtimeSelect.append(option);
    });
    if (!dialog.open) dialog.showModal();
  }

  async function createServerFromModpack(event) {
    event.preventDefault();
    const provision = state.modpackProvision;
    if (!provision) return notify('Choose a modpack release first.', 'error');
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const runtime = provision.runtimes.find((item) => item.id === values.runtime);
    if (!runtime) return notify('Choose a supported modpack runtime.', 'error');
    const button = $('button[type="submit"]', form);
    await withBusy(button, async () => {
      const server = await api('/servers', {
        method: 'POST',
        json: { name: values.name, software: runtime.software, version: runtime.gameVersion, memory: values.memory, cpus: Number(values.cpus) }
      });
      const file = (provision.version.files || []).find((item) => item.primary) || provision.version.files?.[0];
      try {
        await api(`/servers/${encodeURIComponent(server.id)}/content/install`, {
          method: 'POST',
          json: { provider: 'modrinth', projectId: provision.project.id, versionId: provision.version.id, filename: file?.filename || null, kind: 'modpack', replace: true }
        });
      } catch (error) {
        await reloadServers();
        state.selectedServerId = server.id;
        throw new ApiError(`Created ${server.name}, but the pack installation failed: ${error.message}`, error.status);
      }
      state.modpackProvision = null;
      $('#modpack-create-dialog').close();
      $('#version-dialog').close();
      await reloadServers();
      state.selectedServerId = server.id;
      navigate('servers');
      notify(`${server.name} was created for ${provision.project.name || provision.project.id} and the pack was installed. Start it when you are ready.`, 'success', 9000);
    }).catch(() => {});
  }

  async function installProjectVersion(project, version, server, button) {
    if (!serverCapabilities(server).canManage) return notify('Manager access is required to install server content.', 'error');
    const file = (version.files || []).find((item) => item.primary) || version.files?.[0];
    const payload = {
      provider: project.provider || state.provider,
      projectId: project.id,
      versionId: version.id,
      filename: file?.filename || null,
      kind: project.projectType || $('#catalog-type').value,
      gameVersion: server.version,
      loader: providerLoader(server),
      platform: providerLoader(server)
    };
    const isModpack = payload.kind === 'modpack' || /\.mrpack$/i.test(file?.filename || '');
    await withBusy(button, async () => {
      let installResult;
      try {
        installResult = await api(`/servers/${encodeURIComponent(server.id)}/content/install`, { method: 'POST', json: payload });
      } catch (error) {
        if (error.status === 409 && confirm(`${error.message}\n\nReplace the affected server files?`)) {
          installResult = await api(`/servers/${encodeURIComponent(server.id)}/content/install`, { method: 'POST', json: { ...payload, replace: true } });
        } else throw error;
      }
      $('#version-dialog').close();
      const verified = installResult?.checksumVerified?.algorithm ? `${String(installResult.checksumVerified.algorithm).toUpperCase()} verified` : 'checksum verified';
      const dependencies = (installResult?.installedDependencies || []).filter((item) => item.installed).length;
      const installDetails = `${verified}${dependencies ? ` · ${dependencies} required dependenc${dependencies === 1 ? 'y' : 'ies'} installed` : ''}`;
      if (isModpack) {
        await reloadServers();
        const updated = state.servers.find((item) => item.id === server.id);
        const stopped = Boolean(installResult?.stopped) || !updated || updated.status !== 'running';
        notify(stopped
          ? `${project.name || project.id} ${version.versionNumber || version.name} installed (${installDetails}). ${server.name} is stopped; use Start when you are ready.`
          : `${project.name || project.id} ${version.versionNumber || version.name} installed (${installDetails}). ${server.name} is running.`, 'success', 9000);
      } else notify(`${project.name || project.id} ${version.versionNumber || version.name} installed (${installDetails}). Restart the server to load it.`, 'success', 8000);
    }).catch(() => {});
  }

  async function loadMembers() {
    const list = $('#member-list');
    list.replaceChildren(make('div', 'loading-row', 'Loading accounts…'));
    try {
      const result = await api('/access/principals');
      const members = unwrapList(result, 'principals', 'items');
      clear(list);
      if (!members.length) list.append(make('div', 'loading-row', 'Only the bootstrap owner exists.'));
      members.forEach((member) => {
        const account = make('div', 'member-account');
        const row = make('div', 'member-row');
        const details = make('div');
        const quotas = member.quotas || {};
        const usage = member.quota?.usage || {};
        const maxServers = quotas.maxServers === null ? 'unlimited servers' : `${quotas.maxServers ?? 0} servers`;
        const memory = quotas.maxMemoryMiB === null ? 'unlimited RAM' : `${formatBytes((quotas.maxMemoryMiB || 0) * 1024 ** 2)} RAM`;
        const usageSummary = `${usage.servers ?? 0} used · ${formatBytes((usage.memoryMiB || 0) * 1024 ** 2)} RAM · ${formatBytes(usage.storageBytes || 0)} storage`;
        details.append(make('strong', '', member.displayName || member.username), make('small', '', `${member.role} · ${member.status || 'active'} · ${maxServers} · ${memory}`), make('small', '', usageSummary));
        const actions = make('div', 'action-row');
        actions.append(make('span', `status-pill ${member.status === 'disabled' ? 'error' : 'success'}`, member.status || 'active'));
        actions.firstElementChild?.remove();
        const credentials = make('button', 'secondary small', 'Keys');
        credentials.type = 'button';
        const credentialList = make('div', 'credential-list hidden');
        const keyResult = make('div', 'secret-result hidden');
        credentials.addEventListener('click', async () => {
          credentialList.classList.toggle('hidden');
          if (!credentialList.classList.contains('hidden')) await loadCredentials(member, credentialList);
        });
        const issue = make('button', 'secondary small', 'New key');
        issue.type = 'button';
        issue.addEventListener('click', () => issueCredential(member, issue, credentialList, keyResult));
        actions.append(credentials, issue);
        if (member.role !== 'owner') {
          const edit = make('button', 'secondary small', 'Edit');
          edit.type = 'button';
          edit.addEventListener('click', () => openMemberEdit(member));
          const toggle = make('button', 'secondary small', member.status === 'disabled' ? 'Enable' : 'Disable');
          toggle.type = 'button';
          toggle.addEventListener('click', () => toggleMember(member, toggle));
          actions.append(edit, toggle);
        }
        row.append(details, actions);
        account.append(row, keyResult, credentialList);
        list.append(account);
      });
    } catch (error) {
      list.replaceChildren(make('div', 'loading-row', error.status === 404 ? 'Friend accounts become available after the access upgrade is initialized.' : `Unable to load accounts: ${error.message}`));
    }
  }

  async function loadCredentials(member, container) {
    container.replaceChildren(make('div', 'loading-row', 'Loading dashboard keys…'));
    try {
      const credentials = unwrapList(await api(`/access/principals/${encodeURIComponent(member.id)}/credentials`), 'credentials', 'items');
      clear(container);
      if (!credentials.length) container.append(make('div', 'loading-row', 'No dashboard keys remain. Issue a replacement key.'));
      credentials.forEach((credential) => {
        const row = make('div', 'credential-row');
        const details = make('div');
        details.append(make('strong', '', credential.label || 'Dashboard'), make('small', '', `Created ${formatDate(credential.createdAt)}${credential.lastUsedAt ? ` · used ${formatDate(credential.lastUsedAt)}` : ''}`));
        const status = make('span', `status-pill ${credential.revokedAt ? 'error' : 'success'}`, credential.revokedAt ? 'Revoked' : 'Active');
        row.append(details, status);
        if (!credential.revokedAt) {
          const revoke = make('button', 'danger small', 'Revoke');
          revoke.type = 'button';
          revoke.addEventListener('click', () => {
            if (!confirm(`Revoke the ${credential.label || 'dashboard'} key for ${member.displayName || member.username}?`)) return;
            withBusy(revoke, async () => {
              await api(`/access/principals/${encodeURIComponent(member.id)}/credentials/${encodeURIComponent(credential.id)}`, { method: 'DELETE' });
              await loadCredentials(member, container);
              await loadMembers();
            }).catch(() => {});
          });
          row.append(revoke);
        } else {
          const restore = make('button', 'secondary small', 'Re-enable');
          restore.type = 'button';
          restore.addEventListener('click', () => {
            if (!confirm(`Re-enable the ${credential.label || 'dashboard'} key for ${member.displayName || member.username}? Anyone with a copy can sign in again.`)) return;
            withBusy(restore, async () => {
              await api(`/access/principals/${encodeURIComponent(member.id)}/credentials/${encodeURIComponent(credential.id)}`, { method: 'PATCH' });
              await loadCredentials(member, container);
              await loadAccessAudit();
            }).catch(() => {});
          });
          row.append(restore);
        }
        const remove = make('button', 'danger small', 'Delete');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          if (!confirm(`Delete the ${credential.label || 'dashboard'} key for ${member.displayName || member.username}? This cannot be undone.`)) return;
          withBusy(remove, async () => {
            await api(`/access/principals/${encodeURIComponent(member.id)}/credentials/${encodeURIComponent(credential.id)}/delete`, { method: 'POST' });
            await loadCredentials(member, container);
            await loadAccessAudit();
          }).catch(() => {});
        });
        row.append(remove);
        container.append(row);
      });
    } catch (error) {
      container.replaceChildren(make('div', 'loading-row', `Unable to load keys: ${error.message}`));
    }
  }

  async function issueCredential(member, button, credentialList, keyResult) {
    const label = prompt('Label for the new dashboard key', 'Dashboard recovery');
    if (!label) return;
    await withBusy(button, async () => {
      const result = await api(`/access/principals/${encodeURIComponent(member.id)}/credentials`, { method: 'POST', json: { label: label.trim() } });
      clear(keyResult);
      keyResult.classList.remove('hidden');
      keyResult.append(make('strong', '', 'New dashboard key'), make('p', 'muted', 'Copy this once and send it privately. Open MC Host stores only its hash.'));
      const code = make('code', '', result.token);
      const copy = make('button', 'secondary small', 'Copy key');
      copy.type = 'button';
      copy.addEventListener('click', () => copyText(result.token));
      keyResult.append(code, copy);
      credentialList.classList.remove('hidden');
      await loadCredentials(member, credentialList);
      await loadAccessAudit();
    }).catch(() => {});
  }

  function openMemberEdit(member) {
    const dialog = $('#member-edit-dialog');
    const form = $('#member-edit-form');
    const quotas = member.quotas || {};
    form.dataset.principalId = member.id;
    form.elements.role.value = member.role || 'member';
    form.elements.maxServers.value = String(quotas.maxServers ?? 1);
    form.elements.maxMemoryMiB.value = String(quotas.maxMemoryMiB ?? 4096);
    form.elements.maxStorageGiB.value = String(Math.round((quotas.maxStorageBytes || 25 * 1024 ** 3) / 1024 ** 3));
    $('#member-edit-title').textContent = `Edit ${member.displayName || member.username}`;
    dialog.showModal();
  }

  async function saveMemberEdit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const principalId = form.dataset.principalId;
    if (!principalId) return;
    const values = Object.fromEntries(new FormData(form));
    const button = $('button[type="submit"]', form);
    await withBusy(button, async () => {
      await api(`/access/principals/${encodeURIComponent(principalId)}`, {
        method: 'PATCH',
        json: {
          role: String(values.role || '').trim().toLowerCase(),
          quotas: {
            maxServers: Number(values.maxServers),
            maxMemoryMiB: Number(values.maxMemoryMiB),
            maxStorageBytes: Number(values.maxStorageGiB) * 1024 ** 3
          }
        }
      });
      $('#member-edit-dialog').close();
      await loadMembers();
      await loadAccessAudit();
    }).catch(() => {});
  }

  async function toggleMember(member, button) {
    const status = member.status === 'disabled' ? 'active' : 'disabled';
    if (status === 'disabled' && !confirm(`Disable ${member.displayName || member.username}? Their dashboard and SSH credentials will stop working.`)) return;
    await withBusy(button, async () => {
      await api(`/access/principals/${encodeURIComponent(member.id)}`, { method: 'PATCH', json: { status } });
      await loadMembers();
      await loadAccessAudit();
    }).catch(() => {});
  }

  async function loadAccessAudit() {
    const list = $('#access-audit');
    if (!list || state.principal?.role !== 'owner') return;
    list.replaceChildren(make('div', 'loading-row', 'Loading audit history…'));
    try {
      const filter = $('#audit-filter')?.value || 'all';
      const events = unwrapList(await api('/access/audit?limit=100'), 'events', 'items')
        .filter((event) => filter === 'all' || String(event.action || '').startsWith(`${filter}.`) || String(event.action || '').startsWith(`${filter}_`) || (filter === 'account' && String(event.action || '').startsWith('principal.')));
      clear(list);
      if (!events.length) list.append(make('div', 'loading-row', 'No access activity has been recorded yet.'));
      events.forEach((event) => {
        const row = make('div', 'audit-row');
        const details = make('div');
        const action = String(event.action || 'activity').replaceAll('_', ' ').replaceAll('.', ' ');
        const actor = event.actor?.displayName || event.actor?.username || (event.actorId === 'system' ? 'System' : event.actorId?.slice(0, 8) || 'Unknown');
        const subject = event.subject?.displayName || event.subject?.username;
        const server = event.serverId ? state.servers.find((item) => item.id === event.serverId)?.name || `server ${event.serverId.slice(0, 8)}` : '';
        const context = [actor, subject && subject !== actor ? `for ${subject}` : '', server].filter(Boolean).join(' · ');
        details.append(make('strong', '', action), make('small', '', context));
        row.append(details, make('time', 'muted', formatDate(event.at)));
        list.append(row);
      });
    } catch (error) {
      list.replaceChildren(make('div', 'loading-row', `Unable to load audit history: ${error.message}`));
    }
  }

  async function loadSshKeys() {
    const list = $('#ssh-key-list');
    if (!list || !state.principal?.id) return;
    list.replaceChildren(make('div', 'loading-row', 'Loading SSH keys…'));
    try {
      const keys = unwrapList(await api(`/access/principals/${encodeURIComponent(state.principal.id)}/ssh-keys`), 'keys', 'items');
      clear(list);
      if (!keys.length) list.append(make('div', 'loading-row', 'No SSH keys are linked yet. Dashboard access still works normally.'));
      keys.forEach((key) => {
        const row = make('div', 'member-row');
        const details = make('div');
        details.append(make('strong', '', key.label || 'SSH key'), make('small', '', key.fingerprint || 'Fingerprint unavailable'));
        const remove = make('button', 'secondary small', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', async () => {
          if (!confirm(`Remove ${key.label || 'this SSH key'}?`)) return;
          await withBusy(remove, async () => {
            await api(`/access/principals/${encodeURIComponent(state.principal.id)}/ssh-keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
            await loadSshKeys();
          }).catch(() => {});
        });
        row.append(details, remove);
        list.append(row);
      });
    } catch (error) {
      list.replaceChildren(make('div', 'loading-row', `SSH key management is unavailable: ${error.message}`));
    }
  }

  async function addSshKey(event) {
    event.preventDefault();
    if (!state.principal?.id) return;
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const button = $('button', form);
    await withBusy(button, async () => {
      await api(`/access/principals/${encodeURIComponent(state.principal.id)}/ssh-keys`, { method: 'POST', json: { label: values.label, publicKey: values.publicKey } });
      form.elements.publicKey.value = '';
      await loadSshKeys();
      notify('SSH key added. The restricted gateway will synchronize it automatically.', 'success');
    }).catch(() => {});
  }

  async function loadInvites() {
    const list = $('#invite-list');
    if (!list || state.principal?.role !== 'owner') return;
    list.replaceChildren(make('div', 'loading-row', 'Loading pending invites…'));
    try {
      const invites = unwrapList(await api('/access/invites'), 'invites', 'items')
        .filter((invite) => !invite.claimedAt && !invite.revokedAt && (!invite.expiresAt || new Date(invite.expiresAt) > new Date()));
      clear(list);
      if (!invites.length) list.append(make('div', 'loading-row', 'No pending one-time invites.'));
      invites.forEach((invite) => {
        const row = make('div', 'member-row');
        const details = make('div');
        const maxServers = invite.quotas?.maxServers === null ? 'unlimited servers' : `${invite.quotas?.maxServers ?? 0} servers`;
        details.append(make('strong', '', `${invite.role || 'member'} invite`), make('small', '', `${maxServers} · expires ${formatDate(invite.expiresAt)}`));
        const revoke = make('button', 'danger small', 'Revoke');
        revoke.type = 'button';
        revoke.addEventListener('click', () => withBusy(revoke, async () => {
          await api(`/access/invites/${encodeURIComponent(invite.id)}`, { method: 'DELETE' });
          await loadInvites();
          await loadAccessAudit();
        }).catch(() => {}));
        row.append(details, revoke);
        list.append(row);
      });
    } catch (error) {
      list.replaceChildren(make('div', 'loading-row', `Unable to load invites: ${error.message}`));
    }
  }

  async function createInvite(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const button = $('button[type="submit"]', form);
    await withBusy(button, async () => {
      const result = await api('/access/invites', {
        method: 'POST',
        json: {
          role: data.role,
          quotas: { maxServers: Number(data.maxServers), maxMemoryMiB: Number(data.maxMemoryMb), maxStorageBytes: 25 * 1024 ** 3 },
          expiresInHours: 72,
          suggestedDisplayName: data.name
        }
      });
      const code = result.code || result.inviteCode;
      if (!code) throw new ApiError('Invite created, but no invite code was returned.', 502);
      renderInviteResult(data.name, code, result.expiresAt);
      await loadMembers();
      await loadInvites();
    }).catch(() => {});
  }

  function renderInviteResult(name, code, expiresAt) {
    const container = $('#new-access-key');
    clear(container);
    container.classList.remove('hidden');
    container.append(make('strong', '', `Invite for ${name}`));
    const codeNode = make('code', '', code);
    const dashboardUrl = inviteDashboardUrl();
    const inviteUrl = dashboardUrl ? `${dashboardUrl}/#invite=${encodeURIComponent(code)}` : '';
    const instructions = make('p', 'muted', inviteUrl
      ? `Send the invite link privately. It can be redeemed once${expiresAt ? ` before ${formatDate(expiresAt)}` : ''}. Your friend opens the link, chooses a username, and signs in.`
      : 'This code can be redeemed once. Configure Settings → Canonical HTTPS dashboard URL before sharing a friend invite; localhost tunnel links only work for you.');
    const copyCode = make('button', 'secondary small', 'Copy code');
    copyCode.type = 'button';
    copyCode.addEventListener('click', () => copyText(code));
    const actions = make('div', 'action-row');
    actions.append(copyCode);
    if (inviteUrl) {
      const urlNode = make('code', '', inviteUrl);
      const copyLink = make('button', 'secondary small', 'Copy invite link');
      copyLink.type = 'button';
      copyLink.addEventListener('click', () => copyText(inviteUrl));
      actions.append(copyLink);
      container.append(instructions, codeNode, urlNode, actions);
    } else container.append(instructions, codeNode, actions);
  }

  function inviteDashboardUrl() {
    const configured = String(state.settings?.dashboardUrl || '').replace(/\/$/, '');
    if (configured) return configured;
    const host = String(location.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(host);
    return location.protocol === 'https:' && !loopback ? location.origin : '';
  }

  function renderSettings() {
    $('#public-host').value = state.settings?.publicHost || '';
    $('#dashboard-url').value = state.settings?.dashboardUrl || '';
    $('#dashboard-url-status').textContent = state.settings?.dashboardUrl
      ? `New friend invite links will use ${state.settings.dashboardUrl}.`
      : 'Not configured. When you open the panel through an SSH tunnel, invite links cannot use localhost for friends.';
    const connection = state.connection;
    if (!connection) $('#connection-status').textContent = 'Connection status has not been checked.';
    else if (!connection.configured) $('#connection-status').textContent = 'No public hostname is configured. The detected public IP is shown per server.';
    else if (connection.state === 'resolved') $('#connection-status').textContent = `Resolves to ${connection.addresses.join(', ')}.`;
    else if (connection.state === 'unresolved') $('#connection-status').textContent = 'The hostname does not currently resolve. Check its DNS record.';
    else $('#connection-status').textContent = `Configured address: ${connection.addresses.join(', ') || state.settings?.publicHost}.`;
    const panel = state.node?.panel;
    $('#setting-game-ports').textContent = `${state.node?.gamePortRange || 'Unknown'} TCP`;
    $('#setting-panel-binding').textContent = panel?.bindings?.length
      ? panel.bindings.map((binding) => `${binding.hostIp}:${binding.hostPort}`).join(', ')
      : panel?.exposure === 'unpublished' ? 'Not published by Docker' : `${panel?.applicationHost || 'unknown'}:${panel?.applicationPort || 'unknown'}`;
    const exposure = $('#setting-panel-exposure');
    exposure.textContent = panel?.loopbackOnly === true ? 'Loopback only' : panel?.loopbackOnly === false ? 'Network exposed' : 'Unknown — verify firewall';
    exposure.className = panel?.loopbackOnly === true ? 'text-success' : panel?.loopbackOnly === false ? 'text-danger' : '';
  }

  function renderSshCommands() {
    const detected = [state.settings?.publicHost, state.detectedSshHost, ...(state.connection?.addresses || []), location.hostname]
      .map((value) => String(value || '').trim())
      .find((value) => value && !['localhost', '127.0.0.1', '::1'].includes(value.toLowerCase()));
    const command = detected ? `ssh openmchost@${detected}` : 'SSH host is not detected yet. Ask the owner for the server address.';
    $$('[data-ssh-command]').forEach((node) => { node.textContent = command; });
  }

  async function savePublicHost(event) {
    event.preventDefault();
    const button = $('button', event.currentTarget);
    const publicHost = event.currentTarget.elements.publicHost.value.trim();
    await withBusy(button, async () => {
      state.settings = await api('/settings', { method: 'PATCH', json: { publicHost } });
      state.connection = await api('/settings/connection');
      renderSshCommands();
      renderSettings();
      notify('Public join address saved.', 'success');
    }).catch(() => {});
  }

  async function saveDashboardUrl(event) {
    event.preventDefault();
    const button = $('button', event.currentTarget);
    const dashboardUrl = event.currentTarget.elements.dashboardUrl.value.trim();
    await withBusy(button, async () => {
      state.settings = await api('/settings', { method: 'PATCH', json: { dashboardUrl } });
      renderSettings();
      notify(dashboardUrl ? 'Friend dashboard URL saved.' : 'Friend dashboard URL cleared.', 'success');
    }).catch(() => {});
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat(undefined, { notation: Number(value) > 9999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value || 0));
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function formatDuration(value) {
    let seconds = Math.max(0, Math.floor(Number(value) || 0));
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  async function copyText(value) {
    const text = String(value || '').trim();
    if (!text || text === '—' || text.includes('Not detected')) return notify('There is no address to copy yet.', 'error');
    try {
      await navigator.clipboard.writeText(text);
      notify('Copied to clipboard.', 'success', 1800);
    } catch { notify('Clipboard access was blocked. Select and copy the value manually.', 'error'); }
  }

  function initializeTheme() {
    const stored = localStorage.getItem('omh.theme');
    const theme = stored || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = theme;
    renderThemeToggle(theme);
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('omh.theme', next);
    renderThemeToggle(next);
  }

  function renderThemeToggle(theme) {
    const button = $('#theme-toggle');
    const label = theme === 'dark' ? 'Use light theme' : 'Use dark theme';
    button.setAttribute('aria-label', label);
    button.title = label;
    $('.lucide-icon', button).className = `lucide-icon icon-${theme === 'dark' ? 'sun' : 'moon'}`;
  }

  function bindGlobalEvents() {
    document.addEventListener('click', (event) => {
      const routeControl = event.target.closest('[data-route]');
      if (routeControl) {
        event.preventDefault();
        navigate(routeControl.dataset.route);
      }
      const close = event.target.closest('[data-close-dialog]');
      if (close) $(`#${close.dataset.closeDialog}`)?.close();
    });
    window.addEventListener('hashchange', () => renderCurrentRoute());
    $('#mobile-nav').addEventListener('click', () => setMobileNavigation(!document.body.classList.contains('nav-open')));
    $('#nav-overlay').addEventListener('click', () => setMobileNavigation(false, true));
    mobileNavigationMedia.addEventListener('change', () => {
      setMobileNavigation(false);
      setSidebarCollapsed(localStorage.getItem('omh.sidebarCollapsed') === 'true');
    });
    $('#sidebar-toggle-zone').addEventListener('click', () => {
      if (!mobileNavigationMedia.matches) setSidebarCollapsed(false);
    });
    $('#sidebar-close').addEventListener('click', () => {
      if (!mobileNavigationMedia.matches) setSidebarCollapsed(true);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.body.classList.contains('nav-open')) setMobileNavigation(false, true);
    });
    $('#refresh').addEventListener('click', () => refreshAll());
    $('#theme-toggle').addEventListener('click', toggleTheme);
    upgradeRefreshButtons();
    const monitorSelect = $('#overview-monitor-select');
    const monitorActions = make('div', 'overview-monitor-actions');
    const monitorRefresh = make('button', 'icon-button secondary');
    monitorRefresh.type = 'button';
    monitorRefresh.setAttribute('aria-label', 'Refresh selected server usage');
    monitorRefresh.title = 'Refresh selected server usage';
    monitorRefresh.append(lucideIcon('refresh-cw'));
    monitorSelect.closest('label').replaceWith(monitorActions);
    monitorActions.append(monitorSelect.closest('label'), monitorRefresh);
    monitorRefresh.addEventListener('click', () => refreshOverviewMonitor(monitorRefresh));
    $('#overview-monitor-select').addEventListener('change', (event) => {
      state.overviewMonitorId = event.currentTarget.value || null;
      localStorage.setItem('omh.overviewMonitorId', state.overviewMonitorId || '');
      renderOverview();
    });
    $('#logout').addEventListener('click', () => {
      state.token = '';
      state.principal = null;
      localStorage.removeItem('omh.accessKey');
      setGlobalState('Disconnected', 'warning');
      showAccessDialog();
    });
    $('#access-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('button', event.currentTarget);
      $('#access-error').textContent = '';
      try { await withBusy(button, () => connectWithToken($('#access-key').value)); }
      catch (error) { $('#access-error').textContent = error.message; }
    });
    $('#access-dialog').addEventListener('cancel', (event) => {
      if (!state.token) event.preventDefault();
    });
    $('#version-dialog').addEventListener('close', () => { state.requests.projectVersions += 1; });
    $('#modpack-create-form').addEventListener('submit', createServerFromModpack);
    $('#create-form').addEventListener('submit', createServer);
    $('#create-form').addEventListener('reset', () => setTimeout(loadMinecraftVersions));
    $('#create-software').addEventListener('change', loadMinecraftVersions);
    $('#create-version').addEventListener('change', loadServerBuilds);
    $('#catalog-search').addEventListener('click', searchCatalog);
    $('#catalog-query').addEventListener('keydown', (event) => { if (event.key === 'Enter') searchCatalog(); });
    $$('#provider-tabs [role="tab"]').forEach((button) => button.addEventListener('click', () => activateProviderTab(button)));
    $('#provider-tabs').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = $$('#provider-tabs [role="tab"]').filter((tab) => !tab.disabled);
      const current = tabs.indexOf(event.target.closest('[role="tab"]'));
      if (current < 0 || !tabs.length) return;
      event.preventDefault();
      let index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : current + (event.key === 'ArrowRight' ? 1 : -1);
      index = (index + tabs.length) % tabs.length;
      tabs[index].focus();
      activateProviderTab(tabs[index]);
    });
    $('#catalog-server').addEventListener('change', () => {
      state.selectedServerId = $('#catalog-server').value || state.selectedServerId;
      state.requests.catalogSearch += 1;
      state.requests.projectVersions += 1;
    });
    $('#member-form').addEventListener('submit', createInvite);
    $('#member-edit-form').addEventListener('submit', saveMemberEdit);
    $('#invite-refresh').addEventListener('click', loadInvites);
    $('#audit-refresh').addEventListener('click', loadAccessAudit);
    $('#audit-filter').addEventListener('change', loadAccessAudit);
    $('#ssh-key-form').addEventListener('submit', addSshKey);
    $('#public-host-form').addEventListener('submit', savePublicHost);
    $('#dashboard-url-form').addEventListener('submit', saveDashboardUrl);
  }

  function upgradeRefreshButtons(root = document) {
    const selectors = ['#invite-refresh', '#audit-refresh', '[data-action="logs"]', '[data-action="metrics"]', '[data-action="files"]', '[data-action="backups"]', '[data-action="content-refresh"]'];
    selectors.forEach((selector) => $$(selector, root).forEach((button) => {
      const label = button.textContent.trim() || 'Refresh';
      button.classList.add('icon-button', 'secondary');
      button.setAttribute('aria-label', label);
      button.title = label;
      button.replaceChildren(lucideIcon('refresh-cw'));
    }));
  }

  async function initialize() {
    initializeTheme();
    bindGlobalEvents();
    setSidebarCollapsed(localStorage.getItem('omh.sidebarCollapsed') === 'true');
    setMobileNavigation(false);
    state.route = routeFromLocation();
    renderCurrentRoute();
    const invite = location.hash.startsWith('#invite=') ? decodeURIComponent(location.hash.slice('#invite='.length)) : '';
    if (invite) {
      $('#access-key').value = invite;
      showInviteRedemption(invite);
    } else if (!state.token) showAccessDialog();
    if (state.token && !invite) await refreshAll();
    hydrateCatalogControls();
    if (!state.token) {
      const fallback = make('option', '', 'Connect to load exact versions');
      fallback.value = 'LATEST';
      $('#create-version').replaceChildren(fallback);
      $('#create-build').disabled = true;
    }
  }

  initialize().catch((error) => {
    setGlobalState('Unavailable', 'error');
    notify(error.message || 'The dashboard could not initialize.', 'error', 0);
  });
})();
