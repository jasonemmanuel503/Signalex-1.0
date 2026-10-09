// Run npm run setup:python once before pm2 start.
// SIGNALEX — PM2 Development Config
// Usage:
//   pm2 start ecosystem.dev.config.js
//   pm2 logs          (stream logs from both servers)
//   pm2 status        (check both are running)
//   pm2 stop all      (stop everything)
//   pm2 restart all   (restart after .env.local changes)

module.exports = {
  apps: [
    {
      name:          "signalex-web-dev",
      cwd:           "./",
      script:        "node_modules/.bin/next",
      args:          "dev",
      env: {
        NODE_ENV: "development",
        PORT:     3000,
      },
      // NOTE: watch must be false for Next.js — it manages its own file watching.
      // Enabling PM2 watch here causes double-restarts and conflicts.
      watch:         false,
      autorestart:   true,
      max_restarts:  5,
      restart_delay: 2000,
      error_file:    "./logs/web-error.log",
      out_file:      "./logs/web-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name:          "signalex-python-dev",
      cwd:           "./python-backend",
      script:        "main.py",
      interpreter:   "./venv/bin/python",
      // PM2 watches main.py and auto-restarts Python when you save changes
      watch:         ["main.py"],
      ignore_watch:  ["__pycache__", "*.pyc", ".env"],
      autorestart:   true,
      max_restarts:  5,
      restart_delay: 2000,
      error_file:    "../logs/python-error.log",
      out_file:      "../logs/python-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name:          "signalex-po-gateway-dev",
      cwd:           "./po-gateway",
      script:        "-m",
      args:          "uvicorn main:app --host 127.0.0.1 --port 8002 --reload",
      interpreter:   "./venv/bin/python",
      watch:         ["main.py", "po_adapter.py", "fake_adapter.py", "storage.py", "adapter_interface.py"],
      ignore_watch:  ["__pycache__", "*.pyc", ".env"],
      autorestart:   true,
      max_restarts:  5,
      restart_delay: 2000,
      error_file:    "../logs/po-gateway-error.log",
      out_file:      "../logs/po-gateway-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
