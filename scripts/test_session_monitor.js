#!/usr/bin/env node
/**
 * scripts/test_session_monitor.js
 * Verification test for SessionMonitor resilience and Telegram ops alerting.
 */

const assert = require('assert');

// Set required environment variables before importing
process.env.TELEGRAM_BOT_TOKEN = 'test_bot_token';
process.env.TELEGRAM_CHAT_ID = '111';
process.env.TELEGRAM_VIP_CHAT_ID = '222';

let fetchCalls = [];
global.fetch = async function (url, options = {}) {
  const urlStr = String(url);
  const body = options.body ? JSON.parse(options.body) : null;
  const callRecord = { url: urlStr, options, body };
  fetchCalls.push(callRecord);

  // Mock Telegram sendMessage
  if (urlStr.includes('api.telegram.org')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 123 } }),
    };
  }

  // Mock gateway health endpoint
  if (urlStr.includes('/health')) {
    if (global._mockHealthResponse) {
      return global._mockHealthResponse();
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ session: 'valid' }),
    };
  }

  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  };
};

function getTelegramCalls() {
  return fetchCalls.filter((c) => c.url.includes('api.telegram.org'));
}

async function runTests() {
  console.log('--- Starting SessionMonitor and Telegram Alert Tests ---');

  // Dynamically import ESM modules
  const { sendOpsAlert, escapeHtml } = await import('../lib/telegram.js');
  const { SessionMonitor } = await import('../lib/sessionMonitor.js');
  const { orchestrator } = await import('../lib/trading/orchestrator.js');

  // -------------------------------------------------------------
  // Test 1 (F8): sendOpsAlert verifies destination and escaping
  // -------------------------------------------------------------
  console.log('1. Testing sendOpsAlert destination and HTML escaping...');
  fetchCalls = [];
  const escaped = `Alert for ${escapeHtml('<special>')} &amp; "chars"`;
  const alertRes = await sendOpsAlert(escaped);

  const tgCalls1 = getTelegramCalls();
  assert.strictEqual(alertRes.ok, true, 'sendOpsAlert should return ok: true');
  assert.strictEqual(tgCalls1.length, 1, 'sendOpsAlert should make exactly 1 fetch call to Telegram');
  assert.strictEqual(tgCalls1[0].body.chat_id, '111', 'Alert must go to TELEGRAM_CHAT_ID (111)');
  assert.notStrictEqual(tgCalls1[0].body.chat_id, '222', 'Alert must NEVER go to VIP chat (222)');
  assert(tgCalls1[0].body.text.includes('&lt;special&gt;'), 'Special chars must be escaped');
  assert(tgCalls1[0].body.text.includes('&amp;'), '& must be escaped');
  assert(!tgCalls1[0].body.text.includes('<special>'), 'Raw unescaped HTML tags must not be present');
  console.log('   ✓ Test 1 passed.');

  // -------------------------------------------------------------
  // Test 2 (F9 Sequence): valid -> disconnected -> expired -> valid
  // -------------------------------------------------------------
  console.log('2. Testing F9 Sequence: valid -> disconnected -> expired -> valid...');
  fetchCalls = [];

  // Put orchestrator in AUTO mode to verify mode demotion
  orchestrator.state.mode = 'AUTO';

  const monitor = new SessionMonitor();
  let currentMockStatus = 'valid';
  global._mockHealthResponse = () => ({
    ok: true,
    status: 200,
    json: async () => ({ session: currentMockStatus }),
  });

  // Tick 1: First poll grace (valid)
  await monitor.tick();
  assert.strictEqual(getTelegramCalls().length, 0, 'First poll should not send alert');

  // Tick 2: Still valid
  await monitor.tick();
  assert.strictEqual(getTelegramCalls().length, 0, 'Normal valid poll should not send alert');
  assert.strictEqual(orchestrator.state.mode, 'AUTO');

  // Tick 3: Switch to disconnected (bad state 1)
  currentMockStatus = 'disconnected';
  await monitor.tick();

  // Mode should be demoted to SIGNALS
  assert.strictEqual(orchestrator.state.mode, 'SIGNALS', 'Mode must be demoted to SIGNALS');
  const badAlerts1 = getTelegramCalls().filter((c) => c.body?.text?.includes('SignaLex Broker Alert: DISCONNECTED'));
  assert.strictEqual(badAlerts1.length, 1, 'Should send exactly 1 alert for disconnected');

  // Tick 4: Switch to expired (bad state 2)
  currentMockStatus = 'expired';
  await monitor.tick();
  const badAlerts2 = getTelegramCalls().filter((c) => c.body?.text?.includes('SignaLex Broker Alert: EXPIRED'));
  assert.strictEqual(badAlerts2.length, 1, 'Should send exactly 1 alert for expired');

  // Verify G2: NO immediate reminder was sent in the same tick!
  const reminderAlertsBefore30m = getTelegramCalls().filter((c) => c.body?.text?.includes('Reminder: Pocket Option Session Expired'));
  assert.strictEqual(reminderAlertsBefore30m.length, 0, 'No reminder should be sent immediately upon entering expired');

  // Tick 5: 10 minutes later (still expired) -> still no reminder
  const origDateNow = Date.now;
  try {
    let fakeTime = origDateNow.call(Date);
    Date.now = () => fakeTime;

    fakeTime += 10 * 60 * 1000; // +10 mins
    await monitor.tick();
    const reminderAlertsAt10m = getTelegramCalls().filter((c) => c.body?.text?.includes('Reminder: Pocket Option Session Expired'));
    assert.strictEqual(reminderAlertsAt10m.length, 0, 'No reminder at 10 minutes');

    // Tick 6: 30 minutes after initial alert -> reminder should fire
    fakeTime += 21 * 60 * 1000; // now > 30 mins since entering expired
    await monitor.tick();
    const reminderAlertsAt31m = getTelegramCalls().filter((c) => c.body?.text?.includes('Reminder: Pocket Option Session Expired'));
    assert.strictEqual(reminderAlertsAt31m.length, 1, 'Exactly 1 reminder sent after 30 minutes of continued expired');
  } finally {
    Date.now = origDateNow;
  }

  // Tick 7: Switch back to valid (recovery)
  currentMockStatus = 'valid';
  await monitor.tick();

  const restoredAlerts = getTelegramCalls().filter((c) => c.body?.text?.includes('Pocket Option Session Restored'));
  assert.strictEqual(restoredAlerts.length, 1, 'Exactly 1 restored alert should be sent');
  assert.strictEqual(orchestrator.state.mode, 'SIGNALS', 'Mode must NOT auto-restore to SEMI/AUTO (must stay SIGNALS)');

  // Count total bad-state alerts (excluding reminders and restore)
  const totalBadAlerts = getTelegramCalls().filter((c) => c.body?.text?.includes('SignaLex Broker Alert:')).length;
  assert.strictEqual(totalBadAlerts, 2, 'Exactly 2 bad-state alerts sent (1 disconnected, 1 expired)');
  console.log('   ✓ Test 2 passed.');

  // -------------------------------------------------------------
  // Test 3 (F9 Retry): orchestrator.setMode throws once
  // -------------------------------------------------------------
  console.log('3. Testing F9 Retry: setMode failure retried without duplicating audit/alerts...');
  fetchCalls = [];
  const monitorRetry = new SessionMonitor();
  currentMockStatus = 'valid';

  // Seed first poll
  await monitorRetry.tick();

  let setModeAttempts = 0;
  const originalSetMode = orchestrator.setMode.bind(orchestrator);
  orchestrator.setMode = async function (newMode, actor, meta) {
    setModeAttempts++;
    if (setModeAttempts === 1) {
      throw new Error('Simulated transient database error');
    }
    return originalSetMode(newMode, actor, meta);
  };

  try {
    orchestrator.state.mode = 'AUTO';
    currentMockStatus = 'disconnected';

    // Tick 1: setMode fails
    await monitorRetry.tick();
    assert.strictEqual(setModeAttempts, 1);
    assert.strictEqual(monitorRetry.stepFlags.setMode, false, 'stepFlags.setMode should remain false');
    assert.strictEqual(monitorRetry.stepFlags.auditLog, true, 'auditLog should succeed');
    assert.strictEqual(monitorRetry.stepFlags.alert, true, 'alert should succeed');

    const alertsAfterTick1 = getTelegramCalls().filter((c) => c.body?.text?.includes('SignaLex Broker Alert: DISCONNECTED')).length;
    assert.strictEqual(alertsAfterTick1, 1, 'Alert sent on first tick');

    // Tick 2: retry on next tick
    await monitorRetry.tick();
    assert.strictEqual(setModeAttempts, 2, 'setMode should be retried');
    assert.strictEqual(monitorRetry.stepFlags.setMode, true, 'stepFlags.setMode should now be true');
    assert.strictEqual(orchestrator.state.mode, 'SIGNALS', 'Mode should now be SIGNALS');

    const alertsAfterTick2 = getTelegramCalls().filter((c) => c.body?.text?.includes('SignaLex Broker Alert: DISCONNECTED')).length;
    assert.strictEqual(alertsAfterTick2, 1, 'Alert should NOT be repeated on retry tick');
  } finally {
    orchestrator.setMode = originalSetMode;
  }
  console.log('   ✓ Test 3 passed.');

  // -------------------------------------------------------------
  // Test 4 (Boot Grace): unreachable grace period
  // -------------------------------------------------------------
  console.log('4. Testing Boot Grace for unreachable polls...');
  fetchCalls = [];
  const monitorGrace = new SessionMonitor();
  currentMockStatus = 'unreachable';
  global._mockHealthResponse = () => {
    throw new Error('Connection refused');
  };

  // Poll 1: First poll (isFirstPoll = true) -> unreachableConsecutiveCount = 1
  await monitorGrace.tick();
  assert.strictEqual(getTelegramCalls().length, 0, 'Poll 1 (boot) should produce no alert');

  // Poll 2: 2nd consecutive unreachable -> count = 2 (< 3)
  await monitorGrace.tick();
  assert.strictEqual(getTelegramCalls().length, 0, 'Poll 2 should produce no alert (grace count 2 < 3)');

  // Poll 3: 3rd consecutive unreachable -> count = 3 (reaches threshold)
  await monitorGrace.tick();
  const unreachableAlerts = getTelegramCalls().filter((c) => c.body?.text?.includes('SignaLex Broker Alert: UNREACHABLE'));
  assert.strictEqual(unreachableAlerts.length, 1, 'Poll 3 (3rd consecutive) must produce alert');
  console.log('   ✓ Test 4 passed.');

  console.log('All SessionMonitor and Telegram Alert assertions passed successfully.');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
