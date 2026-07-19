const path = require('node:path');

const root = process.cwd();

module.exports = {
  port: Number(process.env.PORT || 3000),
  dataDir: path.resolve(root, process.env.MC_HOST_DATA_DIR || '.data'),
  dockerDataDir: process.env.MC_HOST_DOCKER_DATA_DIR || path.resolve(root, process.env.MC_HOST_DATA_DIR || '.data'),
  image: process.env.MC_HOST_IMAGE || 'itzg/minecraft-server:java25',
  publicHost: process.env.MC_HOST_PUBLIC_HOST || '',
  dashboardUrl: process.env.MC_HOST_DASHBOARD_URL || '',
  lanIp: process.env.MC_HOST_LAN_IP || '',
  networkMode: process.env.MC_HOST_NETWORK_MODE || 'auto',
  portRange: process.env.MC_HOST_PORT_RANGE || '25565-25575',
  maxUploadBytes: Math.max(1, Number(process.env.MC_HOST_MAX_UPLOAD_MB || 250)) * 1024 * 1024,
  autoBackupEnabled: !['0', 'false', 'off'].includes(String(process.env.MC_HOST_AUTO_BACKUP_ENABLED || 'true').toLowerCase()),
  autoBackupHour: Number(process.env.MC_HOST_AUTO_BACKUP_HOUR || 3),
  host: process.env.HOST || '127.0.0.1',
  apiToken: process.env.MC_HOST_API_TOKEN || ''
};
