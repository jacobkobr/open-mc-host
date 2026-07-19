const serverSoftware = [
  { id: 'PAPER', name: 'Paper', category: 'plugin-server', supportsPlugins: true, supportsMods: false, recommended: true },
  { id: 'PURPUR', name: 'Purpur', category: 'plugin-server', supportsPlugins: true, supportsMods: false },
  { id: 'VANILLA', name: 'Vanilla', category: 'official', supportsPlugins: false, supportsMods: false },
  { id: 'FABRIC', name: 'Fabric', category: 'mod-loader', supportsPlugins: false, supportsMods: true },
  { id: 'FORGE', name: 'Forge', category: 'mod-loader', supportsPlugins: false, supportsMods: true },
  { id: 'NEOFORGE', name: 'NeoForge', category: 'mod-loader', supportsPlugins: false, supportsMods: true }
];

module.exports = { serverSoftware };
