const { spawn, execSync } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const pythonBackendDir = path.resolve(rootDir, 'python-backend');
const poGatewayDir = path.resolve(rootDir, 'po-gateway');

let isTerminating = false;
const activeProcesses = [];

// 1. Ensure Python dependencies are installed if missing
try {
  execSync('python3 -c "import fastapi, uvicorn, httpx, pydantic, websockets"', { stdio: 'ignore' });
} catch {
  console.log('[start-all] Python dependencies missing, installing...');
  try {
    execSync('pip3 install --break-system-packages -r python-backend/requirements.txt aiosqlite', {
      cwd: rootDir,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('[start-all] Warning: pip install encountered an issue:', err.message);
  }
}

function launchProcess(name, command, args, cwd, customEnv = {}) {
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    ...customEnv,
  };

  console.log(`[start-all] Launching ${name}...`);
  const proc = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env,
  });

  activeProcesses.push({ name, proc });

  proc.on('exit', (code, signal) => {
    console.log(`[start-all] ${name} exited with code ${code} (signal: ${signal})`);
    if (!isTerminating && name !== 'Next.js') {
      console.log(`[start-all] Auto-restarting ${name} in 2 seconds...`);
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
launchProcess(
  'python-backend',
  'python3',
  ['main.py'],
  pythonBackendDir,
  {
    PYTHON_BACKEND_PORT: process.env.PYTHON_BACKEND_PORT || '8001',
    INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN || 'dev_internal_token_signalex_2026',
  }
);

// 3. Launch Pocket Option Gateway on port 8002
launchProcess(
  'po-gateway',
  'python3',
  ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8002'],
  poGatewayDir,
  {
    PO_USE_FAKE_ADAPTER: process.env.PO_USE_FAKE_ADAPTER || 'true',
    INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN || 'dev_internal_token_signalex_2026',
  }
);

// 4. Launch Next.js dev server on port 3000
const isProd = process.env.NODE_ENV === 'production';
const nextCommand = isProd ? ['next', 'start', '-p', '3000', '-H', '0.0.0.0'] : ['next', 'dev', '-p', '3000', '-H', '0.0.0.0'];

const nextProc = launchProcess(
  'Next.js',
  'npx',
  nextCommand,
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
