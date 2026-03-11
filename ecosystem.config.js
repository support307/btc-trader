module.exports = {
  apps: [
    {
      name: 'discord-trader',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 5000,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      max_memory_restart: '500M',
    },
  ],
};
