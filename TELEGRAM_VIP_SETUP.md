# 📡 Signalex VIP Group — Setup Guide
## V10.0 Auto-Dispatch to Telegram VIP Group

When configured, **every signal and result** is automatically sent to your
"Signalex VIP" group at exactly the same moment as your personal chat.
No delays. No manual forwarding. No time wasted.

---

## Step 1 — Make Signalex Bot an Admin in your VIP Group

1. Open your **Signalex VIP** group in Telegram
2. Tap the group name at the top → **Edit** → **Administrators**
3. Tap **Add Admin** → search for your Signalex bot (e.g. `@SignalexBot`)
4. Grant at minimum: ✅ **Send Messages** permission
5. Tap **Save**

> ⚠️ The bot MUST be an admin to post in groups. If it's only a member, messages will silently fail.

---

## Step 2 — Get Your VIP Group Chat ID

**Method A — @userinfobot (easiest):**
1. Forward any message from your **Signalex VIP** group to [@userinfobot](https://t.me/userinfobot)
2. It will reply with the group info including the **Chat ID**
3. Group/channel IDs start with a minus sign: `-1001234567890`

**Method B — Telegram API:**
1. Send a message in the group
2. Open in browser: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Find `"chat":{"id":` — the negative number is your group ID

---

## Step 3 — Add to Your .env File

Open `python-backend/.env` (or root `.env`) and add:

```env
TELEGRAM_VIP_CHAT_ID=-1001234567890
```

Replace `-1001234567890` with your actual group ID.

---

## Step 4 — Restart the App

```powershell
# Stop the frontend if running (Ctrl+C), then restart:
npm run dev

# Or if using PM2:
pm2 restart signalex-frontend
```

---

## Step 5 — Verify It Works

1. Run a scan in the dashboard
2. Send a signal to Telegram
3. Check your **personal chat** — signal should appear ✅
4. Check your **Signalex VIP group** — same signal should appear simultaneously ✅

---

## What Gets Sent to VIP Group

| Event | Personal Chat | VIP Group |
|-------|--------------|-----------|
| New signal (BUY/SELL) | ✅ | ✅ |
| WIN result | ✅ | ✅ |
| LOSS result | ✅ | ✅ |
| Pre-session brief | ✅ | ✅ |
| Health alerts | ✅ | ✅ |

---

## Troubleshooting

**"Bot is not a member of the group"**
→ Add the bot to the group first, then make it admin.

**"Not enough rights to send messages"**
→ Bot needs Send Messages permission in admin settings.

**Signals appear in personal chat but NOT in VIP group**
→ Check `TELEGRAM_VIP_CHAT_ID` is set correctly — it must be the full negative number.
→ Check server logs for `[telegram] ⚠️ VIP group dispatch failed:` messages.

**How to get logs:**
```powershell
# In the terminal running uvicorn or next dev, look for:
[telegram] ✅ VIP group dispatch OK (-1001234567890)
# or
[telegram] ⚠️  VIP group dispatch failed: Forbidden: bot is not a member
```

---

## Privacy Note

Members of the VIP group will receive the same signal messages as you.
They will NOT see your personal chat ID or any account information.
Message format is identical — professional and clean.
