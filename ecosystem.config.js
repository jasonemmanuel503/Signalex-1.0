// SIGNALEX — PM2 Production Config
// Usage:
//   npm run build              (build Next.js first — one time)
//   pm2 start ecosystem.config.js
//   pm2 save                   (save process list)
//   pm2 startup                (auto-start on server reboot — run the printed command)

module.exports = {
  apps: [
    {
      name:          "signalex-web",
      cwd:           "./",
      script:        "node_modules/.bin/next",
      args:          "start",
      env: {
        NODE_ENV: "production",
        PORT:     3000,
      },
      watch:         false,
      autorestart:   true,
      max_restarts:  10,
      restart_delay: 3000,
      error_file:    "./logs/web-error.log",
      out_file:      "./logs/web-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name:          "signalex-python",
      cwd:           "./python-backend",
      script:        "main.py",
      interpreter:   "python3",
      watch:         false,
      autorestart:   true,
      max_restarts:  10,
      restart_delay: 3000,
      error_file:    "../logs/python-error.log",
      out_file:      "../logs/python-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
