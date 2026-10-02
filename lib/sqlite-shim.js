import fs from "fs";
import path from "path";

class Database {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      trades: [],
      tier_performance: [
        { tier: "A", wins: 0, losses: 0, uses: 0, updated_at: 0 },
        { tier: "B", wins: 0, losses: 0, uses: 0, updated_at: 0 },
        { tier: "C", wins: 0, losses: 0, uses: 0, updated_at: 0 },
      ],
      session_log: [],
      signals: [],
      market_condition_log: [],
      pre_session: [],
    };
    try {
      const jsonPath = filePath ? filePath.replace(/\.db$/, ".json") : null;
      this.jsonPath = jsonPath;
      if (jsonPath && fs.existsSync(jsonPath)) {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        Object.assign(this.data, parsed);
      }
    } catch (e) {
      // fallback to memory
    }
  }

  _save() {
    try {
      if (this.jsonPath) {
        const dir = path.dirname(this.jsonPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.jsonPath, JSON.stringify(this.data, null, 2), "utf-8");
      }
    } catch (e) {
      // ignore
    }
  }

  pragma() {
    return this;
  }

  exec() {
    return this;
  }

  transaction(fn) {
    return (...args) => fn(...args);
  }

  prepare(sql) {
    const trimmed = (sql || "").trim();
    const self = this;

    return {
      run(...args) {
        let params = args;
        if (args.length === 1 && typeof args[0] === "object" && !Array.isArray(args[0]) && args[0] !== null) {
          params = args[0];
        }

        if (trimmed.includes("UPDATE tier_performance")) {
          const tier = params.tier;
          const target = self.data.tier_performance.find(t => t.tier === tier);
          if (target) {
            target.wins = params.wins ?? target.wins;
            target.losses = params.losses ?? target.losses;
            target.uses = params.uses ?? target.uses;
            target.updated_at = params.now || Date.now();
          }
          self._save();
          return { changes: 1 };
        }

        if (trimmed.includes("INSERT INTO session_log")) {
          const record = {
            id: self.data.session_log.length + 1,
            session_key: args[0] || "UNKNOWN",
            wins: args[1] || 0,
            losses: args[2] || 0,
            total: args[3] || 0,
            win_rate: args[4],
            started_at: args[5],
            saved_at: args[6],
            consecutive_losses: args[7] || 0,
            trades_json: args[8] || "[]",
          };
          self.data.session_log.push(record);
          self._save();
          return { changes: 1, lastInsertRowid: record.id };
        }

        if (trimmed.includes("UPDATE session_log")) {
          const startedAt = args[args.length - 1];
          const record = self.data.session_log.find(s => s.started_at === startedAt);
          if (record) {
            record.wins = args[0];
            record.losses = args[1];
            record.total = args[2];
            record.win_rate = args[3];
            record.saved_at = args[4];
            record.consecutive_losses = args[5];
            record.trades_json = args[6];
            record.session_key = args[7];
          }
          self._save();
          return { changes: 1 };
        }

        if (trimmed.includes("DELETE FROM session_log")) {
          self.data.session_log = [];
          self._save();
          return { changes: 1 };
        }

        if (trimmed.includes("INSERT") && trimmed.includes("trades")) {
          self.data.trades.push(typeof params === "object" ? params : { args });
          self._save();
          return { changes: 1 };
        }

        if (trimmed.includes("INSERT") && trimmed.includes("signals")) {
          self.data.signals.push(typeof params === "object" ? params : { args });
          self._save();
          return { changes: 1 };
        }

        if (trimmed.includes("pre_session")) {
          if (trimmed.includes("INSERT")) {
            self.data.pre_session.push(typeof params === "object" ? params : { args });
          }
          self._save();
          return { changes: 1 };
        }

        self._save();
        return { changes: 1 };
      },

      get(...args) {
        if (trimmed.includes("FROM tier_performance")) {
          return self.data.tier_performance[0] || null;
        }
        if (trimmed.includes("FROM session_log")) {
          if (trimmed.includes("ORDER BY id DESC LIMIT 1")) {
            return self.data.session_log[self.data.session_log.length - 1] || null;
          }
          const startedAt = args[0];
          return self.data.session_log.find(s => s.started_at === startedAt) || null;
        }
        if (trimmed.includes("FROM pre_session")) {
          return self.data.pre_session[self.data.pre_session.length - 1] || null;
        }
        if (trimmed.includes("FROM trades")) {
          return self.data.trades[0] || null;
        }
        return null;
      },

      all(...args) {
        if (trimmed.includes("FROM tier_performance")) {
          return self.data.tier_performance;
        }
        if (trimmed.includes("FROM session_log")) {
          const limit = args[0] || 100;
          return [...self.data.session_log].reverse().slice(0, limit);
        }
        if (trimmed.includes("FROM trades")) {
          return self.data.trades;
        }
        if (trimmed.includes("FROM signals")) {
          return self.data.signals;
        }
        if (trimmed.includes("FROM pre_session")) {
          return self.data.pre_session;
        }
        return [];
      },
    };
  }
}

export default Database;
