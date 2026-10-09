// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V10 — Asynchronous Outbox Worker
// Prevents database latency from ever blocking the trading engine or order path.
// ═══════════════════════════════════════════════════════════════════════════════

import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";

const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;

class OutboxQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.startWorker();
  }

  enqueue(topic, payload) {
    const item = {
      id: `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      topic,
      payload,
      retries: 0,
      enqueuedAt: Date.now(),
    };
    this.queue.push(item);
    this.processNext();
    return item.id;
  }

  startWorker() {
    // Regular drain ticker
    const timer = setInterval(() => {
      this.processNext();
    }, 2000);
    if (timer && timer.unref) {
      timer.unref();
    }
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        const success = await this.dispatch(item);

        if (success) {
          this.queue.shift();
        } else {
          item.retries += 1;
          if (item.retries >= MAX_RETRIES) {
            console.error(`[Outbox] Dropping event ${item.id} (${item.topic}) after ${MAX_RETRIES} failed attempts:`, item.payload);
            this.queue.shift();
          } else {
            // Wait with backoff before continuing
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, item.retries);
            await new Promise((res) => setTimeout(res, delay));
            break;
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async dispatch(item) {
    if (!isSupabaseConfigured) {
      // Supabase not configured in this environment; drop peacefully without error
      return true;
    }

    const sb = getSupabaseAdmin();
    if (!sb) return true;

    try {
      const { topic, payload } = item;
      let error = null;

      switch (topic) {
        case "trades:insert": {
          const { error: err } = await sb.from("trades").upsert(payload);
          error = err;
          break;
        }
        case "trades:update": {
          const { id, ...updates } = payload;
          const { error: err } = await sb.from("trades").update(updates).eq("id", id);
          error = err;
          break;
        }
        case "signals:insert": {
          const { error: err } = await sb.from("signals").upsert(payload);
          error = err;
          break;
        }
        case "signals:update": {
          const { id, ...updates } = payload;
          const { error: err } = await sb.from("signals").update(updates).eq("id", id);
          error = err;
          break;
        }
        case "audit:insert": {
          const { error: err } = await sb.from("audit_log").insert(payload);
          error = err;
          break;
        }
        case "settings:update": {
          const { error: err } = await sb.from("app_settings").update(payload).eq("id", 1);
          error = err;
          break;
        }
        case "app_state:upsert": {
          const { error: err } = await sb.from("app_state").upsert(payload);
          error = err;
          break;
        }
        case "market_condition:insert": {
          const { error: err } = await sb.from("market_condition_log").insert(payload);
          error = err;
          break;
        }
        case "kill_switch:insert": {
          const { error: err } = await sb.from("kill_switch_log").insert(payload);
          error = err;
          break;
        }
        case "tier_performance:upsert": {
          const { error: err } = await sb.from("tier_performance").upsert(payload);
          error = err;
          break;
        }
        case "session_log:insert": {
          const { error: err } = await sb.from("session_log").insert(payload);
          error = err;
          break;
        }
        case "pending_confirmation:upsert": {
          const { error: err } = await sb.from("pending_confirmations").upsert(payload);
          error = err;
          break;
        }
        default: {
          console.warn(`[Outbox] Unknown topic: ${topic}`);
          return true;
        }
      }

      if (error) {
        console.warn(`[Outbox] Supabase write error (${topic}):`, error.message);
        return false;
      }

      return true;
    } catch (err) {
      console.warn(`[Outbox] Dispatch network exception (${item.topic}):`, err.message);
      return false;
    }
  }
}

export const outbox = new OutboxQueue();
export default outbox;
