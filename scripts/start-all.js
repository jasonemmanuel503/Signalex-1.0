const { spawn, execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..');
const pythonBackendDir = path.resolve(rootDir, 'python-backend');
const poGatewayDir = path.resolve(rootDir, 'po-gateway');
const backendVenvPython = path.resolve(pythonBackendDir, 'venv/bin/python');
const poVenvPython = path.resolve(poGatewayDir, 'venv/bin/python');

let isTerminating = false;
const activeProcesses = [];
const processCrashStats = {};

// Clean up any stray processes on 8001 and 8002 before starting
function terminateStrayListeners(ports) {
  try {
    const ssOut = execSync('ss -tlpn 2>/dev/null', { encoding: 'utf8' });
    for (const line of ssOut.split('\n')) {
      for (const port of ports) {
        if (line.includes(`:${port}`)) {
          const match = line.match(/pid=(\d+)/);
          if (match) {
            const pid = parseInt(match[1], 10);
            if (pid && pid !== process.pid) {
              console.log(`[start-all] Terminating stray process on port ${port} (PID ${pid})...`);
              try { process.kill(pid, 'SIGKILL'); } catch {}
            }
          }
        }
      }
    }
  } catch {}
}

terminateStrayListeners([8001, 8002]);

// 1. Run reproducible Python environment bootstrapper
const setupScript = path.resolve(__dirname, 'setup-python.js');
try {
  execFileSync(process.execPath, [setupScript], { stdio: 'inherit' });
} catch (err) {
  console.error('[start-all] Warning: setup-python.js exited with an error.');
}

function launchProcess(name, command, args, cwd, customEnv = {}) {
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    ...customEnv,
  };

  if (!processCrashStats[name]) {
    processCrashStats[name] = { quickExitCount: 0, launchTime: Date.now() };
  }
  processCrashStats[name].launchTime = Date.now();

  console.log(`[start-all] Launching ${name}...`);
  const proc = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env,
  });

  activeProcesses.push({ name, proc });

  proc.on('exit', (code, signal) => {
    const elapsedMs = Date.now() - (processCrashStats[name]?.launchTime || 0);
    if (elapsedMs > 60000) {
      processCrashStats[name].quickExitCount = 0;
    }
    if (elapsedMs < 10000) {
      processCrashStats[name].quickExitCount += 1;
    }

    const exitMsg = `${new Date().toISOString()} [start-all] ${name} exited with code ${code} (signal: ${signal})\n`;
    console.log(`[start-all] ${name} exited with code ${code} (signal: ${signal})`);
    try { fs.appendFileSync(path.resolve(rootDir, 'data/launcher.log'), exitMsg); } catch {}

    if (!isTerminating && name !== 'Next.js') {
      if (processCrashStats[name].quickExitCount >= 5) {
        console.error(`[start-all] ERROR: ${name} exited quickly 5 times in a row. Stopping auto-restart (last exit code: ${code}).`);
        return;
      }
      const restartMsg = `${new Date().toISOString()} [start-all] Auto-restarting ${name} in 2 seconds...\n`;
      console.log(`[start-all] Auto-restarting ${name} in 2 seconds...`);
      try { fs.appendFileSync(path.resolve(rootDir, 'data/launcher.log'), restartMsg); } catch {}
      setTimeout(() => {
        if (!isTerminating) {
          launchProcess(name, command, args, cwd, customEnv);
        }
      }, 2000);
    }
  });

  return proc;
}

// 2. Launch Python Market Data Backend (Deriv / Closed Candles) on port 8001
if (fs.existsSync(backendVenvPython)) {
  launchProcess(
    'python-backend',
    backendVenvPython,
    ['main.py'],
    pythonBackendDir,
    {
      PYTHON_BACKEND_PORT: process.env.PYTHON_BACKEND_PORT || '8001',
      INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN || 'dev_internal_token_signalex_2026',
    }
  );
} else {
  console.error('[start-all] python-backend NOT started: venv interpreter missing. Fix: npm run setup:python');
}

// 3. Launch Pocket Option Gateway on port 8002 using venv interpreter
if (fs.existsSync(poVenvPython)) {
  launchProcess(
    'po-gateway',
    poVenvPython,
    ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8002'],
    poGatewayDir,
    {
      PO_USE_FAKE_ADAPTER: process.env.PO_USE_FAKE_ADAPTER || 'false',
      INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN || 'dev_internal_token_signalex_2026',
    }
  );
} else {
  console.error('[start-all] po-gateway NOT started: venv interpreter missing. Fix: npm run setup:python');
}

// 4. Launch Next.js dev server on port 3000
const isProd = process.env.NODE_ENV === 'production';
const localNextBin = path.resolve(rootDir, 'node_modules/.bin/next');
const nextExecutable = fs.existsSync(localNextBin) ? localNextBin : 'next';
const nextArgs = isProd ? ['start', '-p', '3000', '-H', '0.0.0.0'] : ['dev', '-p', '3000', '-H', '0.0.0.0'];

const nextProc = launchProcess(
  'Next.js',
  nextExecutable,
  nextArgs,
  rootDir
);

function cleanup() {
  if (isTerminating) return;
  isTerminating = true;
  console.log('[start-all] Stopping all services...');
  for (const { name, proc } of activeProcesses) {
    try {
      proc.kill('SIGTERM');
    } catch (e) {
      // Ignore
    }
  }
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
nextProc.on('exit', (code) => {
  cleanup();
});
