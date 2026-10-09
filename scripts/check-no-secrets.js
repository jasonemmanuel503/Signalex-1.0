#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SECRET_VARS = [
  'INTERNAL_API_TOKEN',
  'PO_SESSION',
  'PO_REAL_SESSION',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET'
];

const filesToCheck = [
  path.join(__dirname, '..', '.env.example'),
  path.join(__dirname, '..', 'po-gateway', '.env.example')
];

let hasError = false;

for (const filePath of filesToCheck) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!match) return;

    const key = match[1];
    let rawVal = match[2].trim();

    // strip surrounding quotes if present
    if (
      (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
      (rawVal.startsWith("'") && rawVal.endsWith("'"))
    ) {
      rawVal = rawVal.slice(1, -1);
    }

    if (SECRET_VARS.includes(key)) {
      if (rawVal.length > 30) {
        // Must print only variable name and file name, NEVER the value
        console.error(`Secret variable ${key} in ${path.basename(filePath)} exceeds 30 characters!`);
        hasError = true;
      }
    }
  });
}

if (hasError) {
  process.exit(1);
} else {
  console.log('Secrets check passed: no secrets in .env.example files.');
  process.exit(0);
}
