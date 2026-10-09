#!/usr/bin/env node
/**
 * scripts/setup-python.js
 * Reproducible Python environment bootstrapper for SignaLex services.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');
const uvCacheDir = path.join(repoRoot, '.cache', 'uv');

// Ensure cache directory exists
try {
  fs.mkdirSync(uvCacheDir, { recursive: true });
} catch (_) {}

// Parse CLI flags
const args = process.argv.slice(2);
const isCheck = args.includes('--check');
const isDev = args.includes('--dev');
const isOffline = args.includes('--offline') || process.env.UV_OFFLINE === '1';

let targetService = 'all';
const serviceIdx = args.indexOf('--service');
if (serviceIdx !== -1 && args[serviceIdx + 1]) {
  targetService = args[serviceIdx + 1];
}

// 1. Find uv
function findUv() {
  const envPath = process.env.PATH || '';
  const extraPaths = [
    '/usr/local/bin',
    path.join(process.env.HOME || '/root', '.local', 'bin'),
    path.join(process.env.HOME || '/root', '.cargo', 'bin'),
    path.join(repoRoot, '.cache', 'uv', 'bin')
  ];

  const searchPath = `${envPath}:${extraPaths.join(':')}`;

  function checkUv(cmd) {
    try {
      const res = spawnSync(cmd, ['--version'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: searchPath }
      });
      if (res.status === 0 && res.stdout) {
        return cmd;
      }
    } catch (_) {}
    return null;
  }

  let uvCmd = checkUv('uv');
  if (uvCmd) return uvCmd;

  for (const p of extraPaths) {
    const full = path.join(p, 'uv');
    if (fs.existsSync(full)) {
      uvCmd = checkUv(full);
      if (uvCmd) return uvCmd;
    }
  }

  // Attempt 1: python3 -m pip install --user uv
  console.log('[setup-python] uv not found on PATH. Attempting python3 -m pip install --user uv...');
  try {
    const r1 = spawnSync('python3', ['-m', 'pip', 'install', '--user', 'uv'], {
      stdio: 'pipe',
      encoding: 'utf8'
    });
    if (r1.status === 0) {
      uvCmd = checkUv('uv');
      if (uvCmd) return uvCmd;
    }
  } catch (_) {}

  // Attempt 2: pip3 install --user uv
  console.log('[setup-python] Attempting pip3 install --user uv...');
  try {
    const r2 = spawnSync('pip3', ['install', '--user', 'uv'], {
      stdio: 'pipe',
      encoding: 'utf8'
    });
    if (r2.status === 0) {
      uvCmd = checkUv('uv');
      if (uvCmd) return uvCmd;
    }
    if (r2.stderr && r2.stderr.includes('externally-managed-environment')) {
      // Attempt 3: pipx install uv
      console.log('[setup-python] Attempting pipx install uv...');
      const r3 = spawnSync('pipx', ['install', 'uv'], {
        stdio: 'pipe',
        encoding: 'utf8'
      });
      if (r3.status === 0) {
        uvCmd = checkUv('uv');
        if (uvCmd) return uvCmd;
      }
    }
  } catch (_) {}

  // Attempt 4: Unpack standalone wheel directly via python3
  console.log('[setup-python] Attempting standalone uv bootstrap via python3...');
  try {
    const pyBootstrapCode = `
import urllib.request, json, zipfile, io, os, stat
url = "https://pypi.org/pypi/uv/json"
req = urllib.request.Request(url, headers={"User-Agent": "signalex-bootstrap"})
with urllib.request.urlopen(req, timeout=15) as resp:
    data = json.load(resp)
wheel_url = None
for f in data["urls"]:
    if "manylinux_2_17_x86_64.manylinux2014_x86_64.whl" in f["filename"]:
        wheel_url = f["url"]
        break
if wheel_url:
    req_w = urllib.request.Request(wheel_url, headers={"User-Agent": "signalex-bootstrap"})
    with urllib.request.urlopen(req_w, timeout=30) as resp:
        wb = resp.read()
    zf = zipfile.ZipFile(io.BytesIO(wb))
    for n in zf.namelist():
        if n.endswith("/uv") or n == "uv":
            data_bin = zf.read(n)
            target = os.path.expanduser("~/.local/bin/uv")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as out:
                out.write(data_bin)
            os.chmod(target, os.stat(target).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
            print("INSTALLED:" + target)
            break
`;
    const r4 = spawnSync('python3', ['-c', pyBootstrapCode], {
      stdio: 'pipe',
      encoding: 'utf8'
    });
    if (r4.status === 0) {
      uvCmd = checkUv('uv');
      if (uvCmd) return uvCmd;
      const localTarget = path.join(process.env.HOME || '/root', '.local', 'bin', 'uv');
      if (fs.existsSync(localTarget)) {
        uvCmd = checkUv(localTarget);
        if (uvCmd) return uvCmd;
      }
    }
  } catch (_) {}

  console.error('[setup-python] ERROR: Unable to find or install uv automatically.');
  console.error('[setup-python] Please install uv manually: pip install --user uv (or download standalone binary from https://github.com/astral-sh/uv)');
  process.exit(1);
}

const uvBin = findUv();

function runUv(cmdArgs, cwd) {
  const fullEnv = {
    ...process.env,
    UV_CACHE_DIR: uvCacheDir,
    UV_LINK_MODE: 'copy'
  };
  const extraArgs = isOffline ? ['--offline'] : [];
  const result = spawnSync(uvBin, [...cmdArgs, ...extraArgs], {
    cwd,
    env: fullEnv,
    encoding: 'utf8'
  });
  return result;
}

const services = [
  {
    id: 'gateway',
    name: 'po-gateway',
    dir: path.join(repoRoot, 'po-gateway'),
    isGateway: true
  },
  {
    id: 'backend',
    name: 'python-backend',
    dir: path.join(repoRoot, 'python-backend'),
    isGateway: false
  }
];

function calculateStamp(serviceDir, lockFile, expectedPyVer) {
  const lockPath = path.join(serviceDir, lockFile);
  if (!fs.existsSync(lockPath)) return null;
  const content = fs.readFileSync(lockPath);
  return crypto.createHash('sha256').update(content + expectedPyVer + lockFile).digest('hex');
}

function checkServiceHealth(service) {
  const pyVerPath = path.join(service.dir, '.python-version');
  if (!fs.existsSync(pyVerPath)) {
    return {
      healthy: false,
      reason: '.python-version missing',
      pyVer: 'missing',
      stampOk: false,
      importsOk: false,
      pipCheckOk: false,
      sdkVer: 'n/a'
    };
  }

  const expectedPyVer = fs.readFileSync(pyVerPath, 'utf8').trim();
  const venvDir = path.join(service.dir, 'venv');
  const venvPython = path.join(venvDir, 'bin', 'python');
  const lockFile = isDev ? 'requirements-dev.txt' : 'requirements.txt';
  const stampPath = path.join(venvDir, '.signalex-stamp');

  if (!fs.existsSync(venvPython)) {
    return {
      healthy: false,
      reason: 'venv/bin/python does not exist',
      pyVer: expectedPyVer,
      stampOk: false,
      importsOk: false,
      pipCheckOk: false,
      sdkVer: 'none'
    };
  }

  // 1. Python major.minor check
  let actualPyVer = '';
  try {
    const pyVerRes = spawnSync(venvPython, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
      encoding: 'utf8'
    });
    if (pyVerRes.status === 0) {
      actualPyVer = pyVerRes.stdout.trim();
    }
  } catch (_) {}

  if (actualPyVer !== expectedPyVer) {
    return {
      healthy: false,
      reason: `Python version mismatch: expected ${expectedPyVer}, got ${actualPyVer}`,
      pyVer: actualPyVer || 'error',
      stampOk: false,
      importsOk: false,
      pipCheckOk: false,
      sdkVer: 'n/a'
    };
  }

  // 2. Stamp check
  const expectedStamp = calculateStamp(service.dir, lockFile, expectedPyVer);
  let stampOk = false;
  if (fs.existsSync(stampPath) && expectedStamp) {
    const actualStamp = fs.readFileSync(stampPath, 'utf8').trim();
    stampOk = (actualStamp === expectedStamp);
  }

  // 3. Module import check
  let importScript = '';
  if (service.isGateway) {
    importScript = `
from pocket_option import PocketOptionClient
from pocket_option.constants import Regions
from pocket_option.models import Asset, AuthorizationData, SuccessUpdateBalanceEvent, DealAction
from pocket_option.contrib.candles import MemoryCandleStorage
from pocket_option.contrib.assets import MemoryAssetsStorage
from pocket_option.contrib.deals import MemoryDealsStorage
import fastapi, uvicorn, pydantic, dotenv, httpx, aiosqlite
`;
    if (isDev) {
      importScript += `import pytest, pytest_asyncio\n`;
    }
  } else {
    importScript = `
import fastapi, uvicorn, httpx, dotenv, pydantic, websockets, aiosqlite
`;
    if (isDev) {
      importScript += `import pytest\n`;
    }
  }

  const importRes = spawnSync(venvPython, ['-c', importScript], {
    cwd: service.dir,
    encoding: 'utf8'
  });
  const importsOk = (importRes.status === 0);
  let importError = '';
  if (!importsOk) {
    importError = (importRes.stderr || importRes.stdout || '').trim().split('\n').pop();
  }

  // 4. uv pip check
  const checkRes = spawnSync(uvBin, ['pip', 'check', '--python', venvPython], {
    cwd: service.dir,
    env: { ...process.env, UV_CACHE_DIR: uvCacheDir },
    encoding: 'utf8'
  });
  const pipCheckOk = (checkRes.status === 0);
  let pipCheckError = '';
  if (!pipCheckOk) {
    pipCheckError = (checkRes.stderr || checkRes.stdout || '').trim().split('\n').slice(-2).join('; ');
  }

  // 5. SDK version check (gateway only)
  let sdkVer = 'n/a';
  let sdkOk = true;
  if (service.isGateway) {
    const sdkRes = spawnSync(venvPython, ['-c', 'import importlib.metadata; print(importlib.metadata.version("pocket-option"))'], {
      cwd: service.dir,
      encoding: 'utf8'
    });
    if (sdkRes.status === 0) {
      sdkVer = sdkRes.stdout.trim();
      sdkOk = (sdkVer === '0.4.0');
    } else {
      sdkVer = 'missing';
      sdkOk = false;
    }
  }

  const healthy = (stampOk && importsOk && pipCheckOk && sdkOk);
  return {
    healthy,
    reason: healthy ? 'up to date' : 'checks failed',
    pyVer: actualPyVer,
    stampOk,
    importsOk,
    importError,
    pipCheckOk,
    pipCheckError,
    sdkVer,
    expectedStamp,
    venvPython,
    stampPath,
    lockFile,
    expectedPyVer
  };
}

// Check escape hatch: SIGNALEX_SKIP_PY_BOOTSTRAP=1
if (process.env.SIGNALEX_SKIP_PY_BOOTSTRAP === '1') {
  let allHealthy = true;
  for (const svc of services) {
    const h = checkServiceHealth(svc);
    if (!h.healthy) {
      allHealthy = false;
      break;
    }
  }
  if (allHealthy) {
    console.log('[setup-python] WARNING: SIGNALEX_SKIP_PY_BOOTSTRAP=1 set and all environments healthy. Skipping bootstrap.');
    process.exit(0);
  } else {
    console.log('[setup-python] WARNING: SIGNALEX_SKIP_PY_BOOTSTRAP=1 set but environments are NOT healthy. Ignoring skip variable.');
  }
}

// Execute check or setup
const activeServices = services.filter(s => targetService === 'all' || targetService === s.id || targetService === s.name);

if (isCheck) {
  let allOk = true;
  const failureDetails = [];
  console.log('| Service | Python Version | Stamp OK | Imports OK | Pip Check OK | SDK Version |');
  console.log('|---|---|---|---|---|---|');
  for (const svc of activeServices) {
    const h = checkServiceHealth(svc);
    if (!h.healthy) {
      allOk = false;
      if (h.importError) failureDetails.push(`[setup-python] ${svc.name}: import failure: ${h.importError}`);
      if (h.pipCheckError) failureDetails.push(`[setup-python] ${svc.name}: pip check failure: ${h.pipCheckError}`);
      if (!h.stampOk) failureDetails.push(`[setup-python] ${svc.name}: stamp mismatch`);
    }
    console.log(`| ${svc.name} | ${h.pyVer} | ${h.stampOk ? 'OK' : 'FAIL'} | ${h.importsOk ? 'OK' : 'FAIL'} | ${h.pipCheckOk ? 'OK' : 'FAIL'} | ${h.sdkVer} |`);
  }
  for (const det of failureDetails) {
    console.error(det);
  }
  process.exit(allOk ? 0 : 1);
}

// Normal setup mode
for (const svc of activeServices) {
  const h = checkServiceHealth(svc);
  if (h.healthy) {
    console.log(`[setup-python] ${svc.name}: up to date`);
    continue;
  }

  console.log(`[setup-python] ${svc.name}: not healthy (${h.reason}). Bootstrapping virtualenv...`);
  const lockFile = isDev ? 'requirements-dev.txt' : 'requirements.txt';
  const pyVerPath = path.join(svc.dir, '.python-version');
  const expectedPyVer = fs.readFileSync(pyVerPath, 'utf8').trim();
  const venvDir = path.join(svc.dir, 'venv');
  const venvPython = path.join(venvDir, 'bin', 'python');
  const stampPath = path.join(venvDir, '.signalex-stamp');

  // Remove existing stamp
  if (fs.existsSync(stampPath)) {
    try { fs.unlinkSync(stampPath); } catch (_) {}
  }

  // uv venv --clear --python <X.Y> venv
  console.log(`[setup-python] ${svc.name}: creating venv with Python ${expectedPyVer}...`);
  const venvRes = runUv(['venv', '--clear', '--python', expectedPyVer, 'venv'], svc.dir);
  if (venvRes.status !== 0) {
    console.error(`[setup-python] ${svc.name}: failed to create venv!`);
    if (venvRes.stderr) console.error(venvRes.stderr);
    process.exit(1);
  }

  // uv pip sync --python venv/bin/python <lockFile>
  console.log(`[setup-python] ${svc.name}: syncing packages from ${lockFile}...`);
  const syncRes = runUv(['pip', 'sync', '--python', venvPython, lockFile], svc.dir);
  if (syncRes.status !== 0) {
    console.error(`[setup-python] ${svc.name}: failed to sync packages!`);
    if (syncRes.stderr) console.error(syncRes.stderr);
    process.exit(1);
  }

  // Re-verify health
  const recheck = checkServiceHealth(svc);
  if (!recheck.importsOk || !recheck.pipCheckOk || (svc.isGateway && recheck.sdkVer !== '0.4.0')) {
    console.error(`[setup-python] ${svc.name}: verification failed after sync!`);
    if (fs.existsSync(stampPath)) {
      try { fs.unlinkSync(stampPath); } catch (_) {}
    }
    process.exit(1);
  }

  // Write stamp
  const stamp = calculateStamp(svc.dir, lockFile, expectedPyVer);
  fs.writeFileSync(stampPath, stamp + '\n', 'utf8');
  console.log(`[setup-python] ${svc.name}: successfully bootstrapped and stamped (Python ${expectedPyVer}, lock: ${lockFile})`);
}

console.log('[setup-python] All requested Python environments are ready.');
