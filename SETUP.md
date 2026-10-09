# SignaLex — Python Environment Setup

## Prerequisites
- Node.js (v18+)
- `uv` (recommended) or Python 3.13 / `pip`

Never `pip install` into system Python for this project.

## Commands
1. **Bootstrap runtime environments:**
   ```bash
   npm run setup:python
   ```
2. **Bootstrap development/test environments:**
   ```bash
   npm run setup:python:dev
   ```
3. **Verify environment health (read-only):**
   ```bash
   npm run check:python
   ```

## Troubleshooting
- If `uv` is not installed on PATH, install it via:
  ```bash
  pip install --user uv
  ```
- If a lockfile changes or environment becomes corrupt:
  ```bash
  rm -rf po-gateway/venv python-backend/venv
  npm run setup:python
  ```
- If a build fails with network restrictions, ensure the lockfiles and pre-built wheels are cached.
