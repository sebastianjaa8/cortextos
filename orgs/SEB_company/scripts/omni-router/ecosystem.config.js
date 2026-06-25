/**
 * PM2 ecosystem config for OmniRouter.
 *
 * Usage (from this directory):
 *   pm2 start ecosystem.config.js
 *   pm2 logs omni-router
 *   pm2 restart omni-router
 *   pm2 stop omni-router
 *   pm2 save            # persist across reboots
 *
 * The proxy reads its secrets from ./.env (populated from Infisical). PM2 does
 * not need an env block for the keys — proxy.js parses .env itself — but we set
 * NODE_ENV here for good measure.
 */

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'omni-router',
      script: path.join(__dirname, 'proxy.js'),
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 2000,
      kill_timeout: 6000, // > proxy.js 5s grace period so SIGTERM cleanup completes
      watch: false,
      max_memory_restart: '150M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: path.join(__dirname, 'logs', 'omni-router-out.log'),
      error_file: path.join(__dirname, 'logs', 'omni-router-err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
