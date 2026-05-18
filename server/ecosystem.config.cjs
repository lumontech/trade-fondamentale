// PM2 config — gestione process Impact Trading Server.
// Usa: `pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name:   'impact-trading-server',
      script: 'src/index.js',
      cwd:    __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/err.log',
      out_file:   './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
}
