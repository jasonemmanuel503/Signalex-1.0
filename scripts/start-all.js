const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..');
const pythonBackendDir = path.resolve(rootDir, 'python-backend');
const poGatewayDir = path.resolve(rootDir, 'po-gateway');
const poVenvPython = path.resolve(poGatewayDir, 'venv/bin/python');

let isTerminating = false;
const activeProcesses = [];

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

// 1. Ensure Python dependencies for python-backend are installed if missing
try {
  execSync('python3 -c "import fastapi, uvicorn, httpx, pydantic, websockets"', { stdio: 'ignore' });
} catch {
  console.log('[start-all] python-backend dependencies missing, installing...');
  try {
    execSync('pip3 install --break-system-packages -r python-backend/requirements.txt aiosqlite', {
      cwd: rootDir,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('[start-all] Warning: pip install encountered an issue:', err.message);
  }
}

// 2. Ensure po-gateway venv with Python 3.13 and pocket-option is set up
let poVenvValid = false;
if (fs.existsSync(poVenvPython)) {
  try {
    execSync(`"${poVenvPython}" -c "import pocket_option"`, { stdio: 'ignore' });
    poVenvValid = true;
  } catch {
    poVenvValid = false;
  }
}

if (!poVenvValid) {
  console.log('[start-all] po-gateway venv or pocket_option missing, setting up...');
  try {
    execSync('which uv || pip3 install --break-system-packages uv', { stdio: 'inherit' });
    execSync(`uv venv "${path.resolve(poGatewayDir, 'venv')}" --python 3.13`, { cwd: rootDir, stdio: 'inherit' });
    execSync(`uv pip install --python "${poVenvPython}" -r "${path.resolve(poGatewayDir, 'requirements.txt')}"`, {
      cwd: rootDir,
      stdio: 'inherit',
    });
    console.log('[start-all] po-gateway venv successfully initialized with Python 3.13.');
  } catch (err) {
    console.error('[start-all] Error setting up po-gateway venv:', err.message);
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
    const exitMsg = `${new Date().toISOString()} [start-all] ${name} exited with code ${code} (signal: ${signal})\n`;
    console.log(`[start-all] ${name} exited with code ${code} (signal: ${signal})`);
    try { fs.appendFileSync(path.resolve(rootDir, 'data/launcher.log'), exitMsg); } catch {}
    if (!isTerminating && name !== 'Next.js') {
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

// 3. Launch Python Market Data Backend (Deriv / Closed Candles) on port 8001
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

// 4. Launch Pocket Option Gateway on port 8002 using venv interpreter
const poInterpreter = fs.existsSync(poVenvPython) ? poVenvPython : 'python3';
launchProcess(
  'po-gateway',
  poInterpreter,
  ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8002'],
  poGatewayDir,
  {
    PO_USE_FAKE_ADAPTER: process.env.PO_USE_FAKE_ADAPTER || 'false',
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
