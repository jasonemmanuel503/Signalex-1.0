"use client";

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALEX V8.0 — DASHBOARD
//
// HYDRATION FIX:
//   The crash was caused by calling localStorage inside useState(() => {...}).
//   Next.js App Router runs useState initializers on the server during SSR.
//   localStorage doesn't exist on the server, so the try/catch falls through to
//   "en". Then on the client, the lazy initializer runs AGAIN and finds "fr" in
//   localStorage — server HTML says "en" strings, client renders "fr" strings →
//   React detects the mismatch → crash.
//
//   THE CORRECT PATTERN:
//   1. Always initialise lang to "en" (safe on both server and client).
//   2. After mount (useEffect), read localStorage and update if different.
//   3. Render nothing language-sensitive until after mount (useMounted guard).
//   This guarantees server HTML === initial client render → no mismatch.
//
// DESIGN:
//   Microsoft Fluent Design System color palette:
//   - Background: #1a1a2e (deep navy) / #16213e
//   - Accent: #0078d4 (Microsoft Blue — the exact Fluent primary)
//   - Success: #107c10 / #54b054 (Teams green)
//   - Error: #d13438 / #f1707b (Fluent red)
//   - Warning: #ffaa44 (Fluent warning amber)
//   - Surface: rgba(255,255,255,0.04) (Fluent acrylic)
//   - Stroke:  rgba(255,255,255,0.08)
//   Typography hierarchy with Segoe UI weight scale.
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback } from "react";
import styles from "./Dashboard.module.css";
import PauseBanner from "./PauseBanner.js";
import ControlBar from "./ControlBar.js";
import PendingTradeCard from "./PendingTradeCard.js";
import TradesTable from "./TradesTable.js";
import StatsPanel from "./StatsPanel.js";
import SettingsDrawer from "./SettingsDrawer.js";

const LANG_KEY = "signalex_lang_v1";

// ─── Microsoft Fluent semantic color tokens (referenced in inline styles) ──────
const CLR = {
  accent:      "#0078d4",
  accentHov:   "#106ebe",
  accentLight: "rgba(0,120,212,0.15)",
  success:     "#54b054",
  successBg:   "rgba(16,124,16,0.14)",
  error:       "#f1707b",
  errorBg:     "rgba(209,52,56,0.14)",
  warning:     "#ffaa44",
  warningBg:   "rgba(255,170,68,0.12)",
  neutral:     "rgba(255,255,255,0.08)",
  textPrimary: "#ffffff",
  textSecondary:"rgba(255,255,255,0.60)",
  textDisabled: "rgba(255,255,255,0.36)",
};

// ─── i18n ─────────────────────────────────────────────────────────────────────
const T = {
  en: {
    appSub:            "5-LAYER ENGINE · ONE-PAIR DISPATCH · PERSISTENT HISTORY",
    liveData:          "🟢 LIVE DATA",
    simulated:         "🟡 SIMULATED",
    scanning:          "SCANNING",
    locked:            "LOCKED",
    ready:             "READY",
    langBtn:           "FR",
    tabDashboard:      "Dashboard",
    tabTrades:         "Trades",
    tabStats:          "Stats",
    tabSession:        "Session",
    tabConfigure:      "Configure",
    tabTelegram:       "Telegram",
    tabGuide:          "Guide",
    pairsScanned:      "PAIRS SCANNED",
    tradeable:         "TRADEABLE",
    filteredOut:       "FILTERED OUT",
    avgConfidence:     "AVG CONFIDENCE",
    dataSource:        "DATA SOURCE",
    sessionStopped:    "TRADING HALTED",
    sessionStoppedMsg: (n) => `${n} consecutive losses — trading paused for this session.`,
    resumeSession:     "Click Reset Session to resume.",
    tradeExpired:      "TRADE EXPIRED",
    recordResult:      "Record your result — stays open until you close it.",
    win:               "WIN",
    loss:              "LOSS",
    tradeInProgress:   "TRADE IN PROGRESS",
    expiresIn:         "Expires in",
    winLossPrompt:     "WIN / LOSS prompt will appear on expiry",
    scanComplete:      "SCAN COMPLETE",
    sendTelegram:      "Send to Telegram",
    sending:           "Sending…",
    skip:              "Dismiss",
    filterAll:         "All",
    filterOtc:         "OTC",
    filterForex:       "Forex",
    runAnalysis:       "Run Analysis",
    tradeActive:       "Trade Active",
    autoRescan:        "Auto-rescan 1 min after expiry",
    tradeableSignals:  "TRADEABLE SIGNALS",
    filteredOutSec:    "FILTERED OUT",
    readyToScan:       "Ready to analyse",
    clickRun:          "Click Run Analysis to start the 5-layer engine",
    activityLog:       "Activity Log",
    timeframe:         "Timeframe",
    expiry:            "Expiry",
    entryWindow:       "Entry Window",
    marketPhase:       "Market Phase",
    tier:              "Tier",
    quality:           "Quality",
    strength:          "Strength",
    confidence:        "Confidence",
    enterNextCandle:   "Enter on next candle · Max risk 1–2%",
    currentSession:    "Current Session",
    resetSession:      "Reset Session",
    sessionHistory:    "Session History",
    clearAll:          "Clear History",
    clearConfirm:      "Clear all session history? This cannot be undone.",
    noHistory:         "No history yet — results auto-save here after each trade.",
    loadingHistory:    "Loading…",
    total:             "TOTAL",
    wins:              "WINS",
    losses:            "LOSSES",
    winRate:           "WIN RATE",
    recentTrades:      "Recent Trades",
    consecutiveLoss:   "Consecutive losses",
    backendStatus:     "Backend Status",
    pythonBackend:     "Python Backend",
    marketMode:        "Market Mode",
    session:           "Session",
    activePairs:       "Active Pairs",
    betaCalib:         "Gate Calibration",
    betaCalibText:     "Quality floor: 45 · Session pairs: 6 · Cooldown: 4 min · EV fallback ≥ 0.40 · Anti-silence Tier B: 3 min / Tier C: 6 min",
    envVars:           "Environment Variables",
    tgStatus:          "Telegram Status",
    betaDispatch:      "One-Pair Dispatch",
    betaDispatchTxt:   "After each scan you manually approve the best signal. The countdown starts only after a successful send.",
    msgPreview:        "Message Preview",
    runFirst:          "Run an analysis to preview the message",
    quickStart:        "Quick Start",
    betaWorkflow:      "Workflow Guide",
    riskDisclaimer:    "Risk Disclaimer",
    riskText:          "Binary options carry high risk. No system guarantees profits. Max 1–2% risk per trade. Always test on a demo account first.",
    // Pre-session
    preSession:        "PRE-SESSION PLANNER",
    preSessionSub:     "Auto-selects best pairs 15 min before each session",
    runPreScan:        "Run Pre-Session Scan Now",
    preScanning:       "Scanning…",
    sessionBrief:      "SESSION BRIEF SENT",
    noPreScan:         "No pre-scan done yet for this session.",
    nextTrigger:       "Next auto-trigger",
    preSelectedPairs:  "Pre-Selected Pairs",
    backupPairs:       "Backup Pairs",
    selectSession:     "Select session:",
    // Health monitor
    backendHealth:     "BACKEND HEALTH",
    backendOnline:     "Backend Online",
    backendOffline:    "Backend Offline",
    lastCheck:         "Last check",
    consecutiveFails:  "Consecutive failures",
    monitorNote:       "Telegram alerts sent automatically when backend goes offline or recovers.",
    // News blackout
    newsBlackout:      "NEWS BLACKOUT ACTIVE",
    newsBlackoutSub:   (evt, mins) => `${evt} · Signals resume in ${mins} min`,
    newsCalendar:      "Today's High-Impact Events",
    newsCalendarEmpty: "No high-impact events scheduled today.",
    newsRefresh:       "Refresh",
    newsLoading:       "Loading calendar…",
    poInstruction:     "Pocket Option Entry",
    guideSteps: [
      ["1", "Install dependencies",   "npm install"],
      ["2", "Set up environment",      "cp .env.local.example .env.local — add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID"],
      ["3", "Start Python backend",    "cd python-backend && pip install -r requirements.txt && python main.py"],
      ["4", "Start with PM2",          "npm i -g pm2 && pm2 start ecosystem.dev.config.js"],
      ["5", "Without PM2",             "npm run dev → open http://localhost:3000"],
      ["6", "Deploy to production",    "npm run build && pm2 start ecosystem.config.js && pm2 save && pm2 startup"],
    ],
    guideWorkflow: [
      ["Scan",        "Click Run Analysis. The 5-layer engine fetches live data and scores all pairs."],
      ["Filter",      "Click All / OTC / Forex to filter the results instantly — no rescan needed."],
      ["Review",      "The top tradeable pair is highlighted. Blocked pairs are listed below for transparency."],
      ["Send",        "Click Send to Telegram. Only ONE pair is dispatched per cycle."],
      ["Countdown",   "A live countdown tracks the trade expiry after the signal is sent."],
      ["WIN / LOSS",  "On expiry a persistent prompt appears. Tap WIN or LOSS, or ✕ to close without recording. No auto-close."],
      ["Auto-rescan", "2 minutes after expiry the engine rescans automatically if the checkbox is enabled."],
      ["Stop-loss",   "After 2 consecutive losses trading halts automatically. Click Reset Session to resume."],
      ["History",     "All trade results are stored in SQLite and persist across server restarts and browser cache clears."],
    ],
  },

  fr: {
    appSub:            "MOTEUR 5 COUCHES · DISPATCH UNE PAIRE · HISTORIQUE PERSISTANT",
    liveData:          "🟢 DONNÉES EN DIRECT",
    simulated:         "🟡 SIMULÉ",
    scanning:          "ANALYSE EN COURS",
    locked:            "VERROUILLÉ",
    ready:             "PRÊT",
    langBtn:           "EN",
    tabDashboard:      "Tableau de bord",
    tabTrades:         "Trades",
    tabStats:          "Statistiques",
    tabSession:        "Session",
    tabConfigure:      "Configurer",
    tabTelegram:       "Telegram",
    tabGuide:          "Guide",
    pairsScanned:      "PAIRES ANALYSÉES",
    tradeable:         "TRADABLES",
    filteredOut:       "FILTRÉES",
    avgConfidence:     "CONFIANCE MOY.",
    dataSource:        "SOURCE DONNÉES",
    sessionStopped:    "TRADING SUSPENDU",
    sessionStoppedMsg: (n) => `${n} pertes consécutives — trading suspendu pour cette session.`,
    resumeSession:     "Cliquez sur Réinitialiser pour reprendre.",
    tradeExpired:      "TRADE EXPIRÉ",
    recordResult:      "Enregistrez le résultat — reste ouvert jusqu'à fermeture manuelle.",
    win:               "GAIN",
    loss:              "PERTE",
    tradeInProgress:   "TRADE EN COURS",
    expiresIn:         "Expire dans",
    winLossPrompt:     "La fenêtre GAIN / PERTE apparaîtra à l'expiration",
    scanComplete:      "SCAN TERMINÉ",
    sendTelegram:      "Envoyer sur Telegram",
    sending:           "Envoi…",
    skip:              "Ignorer",
    filterAll:         "Tout",
    filterOtc:         "OTC",
    filterForex:       "Forex",
    runAnalysis:       "Lancer l'Analyse",
    tradeActive:       "Trade Actif",
    autoRescan:        "Re-scan auto 1 min après expiration",
    tradeableSignals:  "SIGNAUX TRADABLES",
    filteredOutSec:    "FILTRÉS",
    readyToScan:       "Prêt à analyser",
    clickRun:          "Cliquez sur Lancer l'Analyse pour démarrer le moteur 5 couches",
    activityLog:       "Journal d'activité",
    timeframe:         "Unité de temps",
    expiry:            "Expiration",
    entryWindow:       "Fenêtre d'entrée",
    marketPhase:       "Phase de marché",
    tier:              "Niveau",
    quality:           "Qualité",
    strength:          "Force",
    confidence:        "Confiance",
    enterNextCandle:   "Entrer à la prochaine bougie · Risque max 1–2%",
    currentSession:    "Session en cours",
    resetSession:      "Réinitialiser",
    sessionHistory:    "Historique des sessions",
    clearAll:          "Effacer l'historique",
    clearConfirm:      "Effacer tout l'historique ? Action irréversible.",
    noHistory:         "Aucun historique — les résultats s'enregistrent automatiquement.",
    loadingHistory:    "Chargement…",
    total:             "TOTAL",
    wins:              "GAINS",
    losses:            "PERTES",
    winRate:           "TAUX DE RÉUSSITE",
    recentTrades:      "Trades récents",
    consecutiveLoss:   "Pertes consécutives",
    backendStatus:     "État du backend",
    pythonBackend:     "Backend Python",
    marketMode:        "Mode marché",
    session:           "Session",
    activePairs:       "Paires actives",
    betaCalib:         "Calibration des filtres",
    betaCalibText:     "Seuil qualité : 45 · Paires session : 6 · Cooldown : 4 min · EV fallback ≥ 0.40 · Anti-silence Tier B : 3 min / Tier C : 6 min",
    envVars:           "Variables d'environnement",
    tgStatus:          "Statut Telegram",
    betaDispatch:      "Dispatch une paire",
    betaDispatchTxt:   "Après chaque scan, vous approuvez manuellement le meilleur signal. Le compte à rebours démarre après l'envoi réussi.",
    msgPreview:        "Aperçu du message",
    runFirst:          "Lancez une analyse pour prévisualiser le message",
    quickStart:        "Démarrage rapide",
    betaWorkflow:      "Guide d'utilisation",
    riskDisclaimer:    "Avertissement risque",
    riskText:          "Les options binaires comportent des risques élevés. Aucun système ne garantit les profits. Risque max 1–2% par trade. Testez toujours en démo d'abord.",
    // Pre-session
    preSession:        "PLANIFICATION PRÉ-SESSION",
    preSessionSub:     "Sélectionne automatiquement les meilleures paires 15 min avant chaque session",
    runPreScan:        "Lancer le Scan Pré-Session Maintenant",
    preScanning:       "Analyse…",
    sessionBrief:      "BRIEF SESSION ENVOYÉ",
    noPreScan:         "Aucun pré-scan effectué pour cette session.",
    nextTrigger:       "Prochain déclenchement automatique",
    preSelectedPairs:  "Paires Pré-Sélectionnées",
    backupPairs:       "Paires de Secours",
    selectSession:     "Choisir la session :",
    // Health monitor
    backendHealth:     "SANTÉ DU BACKEND",
    backendOnline:     "Backend En Ligne",
    backendOffline:    "Backend Hors Ligne",
    lastCheck:         "Dernière vérif.",
    consecutiveFails:  "Échecs consécutifs",
    monitorNote:       "Alertes Telegram envoyées automatiquement quand le backend tombe ou revient en ligne.",
    // News blackout
    newsBlackout:      "BLOCAGE ACTUALITÉS ACTIF",
    newsBlackoutSub:   (evt, mins) => `${evt} · Signaux reprennent dans ${mins} min`,
    newsCalendar:      "Événements à fort impact aujourd'hui",
    newsCalendarEmpty: "Aucun événement à fort impact prévu aujourd'hui.",
    newsRefresh:       "Actualiser",
    newsLoading:       "Chargement du calendrier…",
    poInstruction:     "Entrée Pocket Option",
    guideSteps: [
      ["1", "Installer les dépendances",  "npm install"],
      ["2", "Configurer l'environnement", "cp .env.local.example .env.local — ajoutez TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID"],
      ["3", "Démarrer le backend Python", "cd python-backend && pip install -r requirements.txt && python main.py"],
      ["4", "Démarrer avec PM2",          "npm i -g pm2 && pm2 start ecosystem.dev.config.js"],
      ["5", "Sans PM2",                   "npm run dev → ouvrir http://localhost:3000"],
      ["6", "Déployer en production",     "npm run build && pm2 start ecosystem.config.js && pm2 save && pm2 startup"],
    ],
    guideWorkflow: [
      ["Scan",           "Cliquez sur Lancer l'Analyse. Le moteur 5 couches récupère les données en direct et note toutes les paires."],
      ["Filtrer",        "Cliquez sur Tout / OTC / Forex pour filtrer les résultats instantanément — pas besoin de rescanner."],
      ["Examiner",       "La meilleure paire tradable est mise en avant. Les paires bloquées sont listées en dessous pour la transparence."],
      ["Envoyer",        "Cliquez sur Envoyer sur Telegram. Une seule paire est envoyée par cycle."],
      ["Compte à rebours","Un compte à rebours suit l'expiration du trade après l'envoi."],
      ["GAIN / PERTE",   "À l'expiration une fenêtre persistante apparaît. Touchez GAIN ou PERTE, ou ✕ pour fermer sans enregistrer. Pas de fermeture automatique."],
      ["Re-scan auto",   "2 minutes après l'expiration le moteur rescanne automatiquement si la case est cochée."],
      ["Stop-loss",      "Après 2 pertes consécutives le trading s'arrête automatiquement. Cliquez sur Réinitialiser pour reprendre."],
      ["Historique",     "Tous les résultats sont stockés dans SQLite et persistent entre les redémarrages serveur et les vidages de cache."],
    ],
  },
};

// ─── Pair sets for client-side instant filter ──────────────────────────────────
const FOREX_IDS = new Set([
  "EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD","USD/CAD",
  "EUR/JPY","GBP/JPY","EUR/GBP","AUD/JPY","NZD/USD","EUR/CHF","GBP/CHF","USD/SGD",
]);
const OTC_IDS = new Set([
  "EUR/USD OTC","GBP/USD OTC","USD/JPY OTC","AUD/USD OTC","USD/CAD OTC",
  "EUR/GBP OTC","NZD/USD OTC","USD/CHF OTC","EUR/JPY OTC","GBP/JPY OTC",
  "AUD/JPY OTC","EUR/CHF OTC",
]);

function applyMarketFilter(signals, mode) {
  if (mode === "forex") return signals.filter((s) => FOREX_IDS.has(s.pair) || s.pair === "SYSTEM");
  if (mode === "otc")   return signals.filter((s) => OTC_IDS.has(s.pair)   || s.pair === "SYSTEM");
  return signals;
}

function pause(ms) { return new Promise((r) => setTimeout(r, ms)); }

function buildPreview(sig, rank, total) {
  if (!sig) return "";
  return [
    `🔥 SIGNAL #${rank}/${total} — ${sig.pair}`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `${sig.direction === "BUY" ? "🟢" : "🔴"} ${sig.direction === "BUY" ? "▲ BUY" : "▼ SELL"}`,
    `⏱ Timeframe: ${sig.timeframe}`,
    `🟠 Expiry: ${sig.expiry}`,
    `💯 Confidence: ${sig.confidence}%`,
    sig.entryWindow        ? `⏰ Entry: ${sig.entryWindow}` : null,
    sig.marketPhase        ? `📊 Phase: ${sig.marketPhase}` : null,
    sig.signalTier         ? `⭐ Tier: ${sig.signalTier}` : null,
    sig.marketQualityScore !== undefined ? `📋 Quality: ${sig.marketQualityScore}/100` : null,
    ``, `Analysis:`,
    ...(sig.reasons ? Object.values(sig.reasons).filter(Boolean).map((r) => `✅ ${r}`) : []),
    ...(sig.warnings?.length ? ["", ...sig.warnings.map((w) => `⚠️ ${w}`)] : []),
    ``, `→ Enter on next candle · Risk max 1–2%`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🤖 SIGNALEX V8.0 — Rule-Based Signal Engine`,
  ].filter((l) => l !== null).join("\n");
}

const TAB_KEYS = ["tabDashboard", "tabTrades", "tabStats", "tabSession", "tabConfigure", "tabTelegram", "tabGuide"];

// ═══════════════════════════════════════════════════════════════════════════════
export default function Dashboard() {
  // ── HYDRATION FIX ────────────────────────────────────────────────────────────
  // Step 1: always start with "en" — safe on server and client alike.
  const [lang, setLang] = useState("en");
  // Step 2: gate all rendering on mount so server HTML === initial client render.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Step 3: after mount read localStorage and sync (client only, no SSR mismatch).
    try {
      const saved = localStorage.getItem(LANG_KEY);
      if (saved === "fr") setLang("fr");
    } catch {}
    setMounted(true);
  }, []);

  const switchLang = () => {
    const next = lang === "en" ? "fr" : "en";
    setLang(next);
    try { localStorage.setItem(LANG_KEY, next); } catch {}
  };

  // Use "en" dict until mounted so SSR and initial client render match exactly.
  const t = mounted ? T[lang] : T["en"];
  // ─────────────────────────────────────────────────────────────────────────────

  const [tab,              setTab]             = useState(0);
  const [mobileNavOpen,    setMobileNavOpen]   = useState(false);
  const [loading,          setLoading]         = useState(false);
  const [loadStep,         setLoadStep]        = useState("");
  const [signals,          setSignals]         = useState([]);
  const [scanMeta,         setScanMeta]        = useState(null);
  const [mode,             setMode]            = useState("all");
  const [logs,             setLogs]            = useState([]);
  const [tgPreview,        setTgPreview]       = useState("");
  const [tgStatus,         setTgStatus]        = useState(null);
  const [time,             setTime]            = useState("");
  const [controller,       setController]      = useState(null);
  const [autoRescan,       setAutoRescan]      = useState(true);
  const [pendingSend,      setPendingSend]     = useState(null);
  const [sendingTg,        setSendingTg]       = useState(false);
  const [resultPrompt,     setResultPrompt]    = useState(false);
  const [resultSubmitting, setResultSubmitting]= useState(false);
  const [sessionHistory,   setSessionHistory]  = useState([]);
  const [historyLoaded,    setHistoryLoaded]   = useState(false);
  const [sessionStopped,   setSessionStopped]  = useState(false);
  const [liveSecsLeft,     setLiveSecsLeft]    = useState(null);
  // V7.0.3: News blackout state
  const [newsBlocked,      setNewsBlocked]     = useState(false);
  const [newsEvent,        setNewsEvent]       = useState(null);
  const [newsMinutesLeft,  setNewsMinutesLeft] = useState(0);
  const [newsNextClear,    setNewsNextClear]   = useState(null);
  const [newsCalendar,     setNewsCalendar]    = useState([]);
  const [newsLoading,      setNewsLoading]     = useState(false);
  // V8.0: Pre-session scheduler state
  const [preSessionData,   setPreSessionData]  = useState(null);   // full GET /api/pre-session response
  const [preScanning,      setPreScanning]     = useState(false);
  const [preScanSession,   setPreScanSession]  = useState("LONDON"); // selected session for manual override
  // V10.0: Market forecast panel state
  const [forecastData,     setForecastData]    = useState(null);
  const [forecastLoading,  setForecastLoading] = useState(false);
  const [forecastOpen,     setForecastOpen]    = useState(true);
  const [forecastLastRun,  setForecastLastRun] = useState(null);
  // V10.0: Secondary signal persistence
  const [secondarySignals, setSecondarySignals] = useState([]);
  // V8.0: Health monitor state
  const [healthStatus,     setHealthStatus]    = useState(null);   // GET /api/health-monitor response
  // [KILL-SWITCH-UI] Active kill-switch pauses — populated from API response killSwitchPauses[]
  const [killSwitchPauses, setKillSwitchPauses] = useState([]);

  // ── SIGNALEX V10 Pocket Option Orchestrator & Control State ──
  const [controlState, setControlState] = useState(null);
  const [pendingList,  setPendingList]  = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const fetchControl = useCallback(async () => {
    try {
      const res = await fetch("/api/control");
      if (res.ok) {
        const data = await res.json();
        setControlState(data);
      }
    } catch {
      // Silently fail safely
    }
  }, []);

  const fetchPending = useCallback(async () => {
    try {
      const res = await fetch("/api/pending");
      if (res.ok) {
        const data = await res.json();
        setPendingList(data.pending || []);
      }
    } catch {
      // Silently fail safely
    }
  }, []);

  useEffect(() => {
    fetchControl();
    fetchPending();
    const ctrlInterval = setInterval(fetchControl, 2500);
    const pendInterval = setInterval(fetchPending, 2000);
    return () => {
      clearInterval(ctrlInterval);
      clearInterval(pendInterval);
    };
  }, [fetchControl, fetchPending]);

  const liveCountTm   = useRef(null);
  const logRef        = useRef(null);
  const rescanTm      = useRef(null);
  const tradeExpTimer = useRef(null);

  const displayedSignals = applyMarketFilter(signals, mode);
  const tradeable        = displayedSignals.filter((s) => !s.noTrade);
  const blocked          = displayedSignals.filter((s) =>  s.noTrade && s.pair !== "SYSTEM");
  const topSignal        = tradeable[0] || null;
  const tradeActive      = controller?.activeTrade ?? false;
  const tradeSecsLeft    = liveSecsLeft ?? (controller?.activeTradeSecondsLeft ?? 0);

  // ── addLog MUST be defined first — used by fetchNewsCalendar and useEffects below ──
  const addLog = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => [...prev.slice(-80), { ts, msg, type }]);
  }, []);

  const loadHistoryFromAPI = useCallback(async () => {
    try {
      const res  = await fetch("/api/analyze?history=1");
      const data = await res.json();
      if (data.ok && Array.isArray(data.history)) setSessionHistory(data.history);
    } catch {}
    setHistoryLoaded(true);
  }, []);

  // V7.0.3: fetch news calendar — called on mount and by Refresh button
  const fetchNewsCalendar = useCallback(async (forceRefresh = false) => {
    setNewsLoading(true);
    try {
      const url  = `/api/analyze?news=1${forceRefresh ? "&refresh=1" : ""}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (data.ok) {
        setNewsBlocked(data.blocked ?? false);
        setNewsEvent(data.activeEvent ?? null);
        setNewsMinutesLeft(data.minutesLeft ?? 0);
        setNewsNextClear(data.nextClearAt ?? null);
        setNewsCalendar(data.upcomingEvents ?? []);
        if (data.blocked) {
          addLog(`🚫 NEWS BLACKOUT — ${data.activeEvent?.event ?? "High-impact event"} · resumes in ${data.minutesLeft} min`, "warn");
        }
      }
    } catch { /* silent */ }
    finally { setNewsLoading(false); }
  }, [addLog]);

  // V10.0: Fetch market forecast + daily outlook
  const fetchForecast = useCallback(async (forceRun = false) => {
    setForecastLoading(true);
    try {
      let data;
      if (forceRun) {
        // POST triggers a fresh on-demand run with live data
        const res = await fetch("/api/forecast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
        data = await res.json();
      } else {
        const res = await fetch("/api/forecast");
        data = await res.json();
      }
      if (data.ok) {
        setForecastData(data);
        setForecastLastRun(new Date());
        if (forceRun) addLog("📡 Market forecast refreshed with live data", "info");
      }
    } catch (err) {
      addLog(`⚠️ Forecast fetch error: ${err.message}`, "warn");
    } finally {
      setForecastLoading(false);
    }
  }, [addLog]);

  // V10.0: Secondary signal handlers — persist in sessionStorage
  const loadSecondarySignals = useCallback(() => {
    try {
      const saved = sessionStorage.getItem("signalex_secondary_signals");
      if (saved) {
        const parsed = JSON.parse(saved);
        // Filter out signals older than 4 hours
        const fresh = parsed.filter(s => Date.now() - (s.savedAt ?? 0) < 4 * 60 * 60 * 1000);
        setSecondarySignals(fresh);
      }
    } catch {}
  }, []);

  const saveSecondarySignals = useCallback((sigs) => {
    try {
      sessionStorage.setItem("signalex_secondary_signals", JSON.stringify(sigs));
    } catch {}
  }, []);

  const addSecondarySignal = useCallback((signal) => {
    setSecondarySignals(prev => {
      // Don't duplicate
      if (prev.find(s => s.id === signal.id)) return prev;
      const updated = [...prev, { ...signal, savedAt: Date.now(), status: "PENDING", result: null }];
      saveSecondarySignals(updated);
      return updated;
    });
  }, [saveSecondarySignals]);

  const cancelSecondarySignal = useCallback((id) => {
    setSecondarySignals(prev => {
      const updated = prev.filter(s => s.id !== id);
      saveSecondarySignals(updated);
      addLog(`❌ Secondary signal cancelled`, "info");
      return updated;
    });
  }, [saveSecondarySignals, addLog]);

  const markSecondaryResult = useCallback(async (id, result) => {
    try {
      const res = await fetch("/api/manual-execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "result", result }),
      });
      const data = await res.json();
      if (data.ok) {
        setSecondarySignals(prev => {
          const updated = prev.map(s => s.id === id ? { ...s, result, status: "DONE" } : s);
          saveSecondarySignals(updated);
          return updated;
        });
        addLog(`✅ Secondary ${result} recorded`, result === "WIN" ? "success" : "error");
      }
    } catch (err) {
      addLog(`❌ Secondary result error: ${err.message}`, "error");
    }
  }, [saveSecondarySignals, addLog]);

  useEffect(() => { loadHistoryFromAPI(); }, [loadHistoryFromAPI]);

  // Poll news calendar every 5 minutes and on mount
  useEffect(() => {
    if (!mounted) return;
    fetchNewsCalendar();
    const id = setInterval(() => fetchNewsCalendar(), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [mounted, fetchNewsCalendar]);

  // V10.0: Fetch forecast on mount and every 30 minutes
  useEffect(() => {
    if (!mounted) return;
    fetchForecast(false);
    const id = setInterval(() => fetchForecast(false), 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [mounted, fetchForecast]);

  // V10.0: Load persisted secondary signals from sessionStorage on mount
  useEffect(() => {
    if (!mounted) return;
    loadSecondarySignals();
  }, [mounted, loadSecondarySignals]);

  // V8.0: Fetch pre-session scheduler state
  const fetchPreSession = useCallback(async () => {
    try {
      const res  = await fetch("/api/pre-session");
      const data = await res.json();
      if (data.ok) setPreSessionData(data);
    } catch { /* silent */ }
  }, []);

  // V8.0: Fetch health monitor status
  const fetchHealthStatus = useCallback(async () => {
    try {
      const res  = await fetch("/api/health-monitor");
      const data = await res.json();
      if (data.ok) setHealthStatus(data);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    fetchPreSession();
    fetchHealthStatus();
    // Poll pre-session every 2 min, health every 30s
    const psId = setInterval(fetchPreSession,    2 * 60 * 1000);
    const hmId = setInterval(fetchHealthStatus,  30 * 1000);
    return () => { clearInterval(psId); clearInterval(hmId); };
  }, [mounted, fetchPreSession, fetchHealthStatus]);

  // V8.0: Manual pre-session scan trigger
  const runManualPreScan = async () => {
    setPreScanning(true);
    try {
      const res  = await fetch("/api/pre-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey: preScanSession }),
      });
      const data = await res.json();
      if (data.ok) {
        addLog(`📋 Pre-scan done for ${preScanSession}: ${data.selectedPairs?.length ?? 0} pairs selected`, "success");
        await fetchPreSession();
      } else {
        addLog(`Pre-scan failed: ${data.error ?? "unknown error"}`, "error");
      }
    } catch (err) { addLog(`Pre-scan error: ${err.message}`, "error"); }
    finally { setPreScanning(false); }
  };
  useEffect(() => {
    if (controller?.sessionLog?.total > 0) loadHistoryFromAPI();
  }, [controller?.sessionLog?.total, loadHistoryFromAPI]);

  useEffect(() => {
    const tick = () => setTime(new Date().toLocaleTimeString("en-US", { hour12: false }));
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (liveCountTm.current) { clearInterval(liveCountTm.current); liveCountTm.current = null; }
    if (!controller?.activeTrade || !controller?.activeTradeExpiresAt) { setLiveSecsLeft(null); return; }
    const expiresAt = new Date(controller.activeTradeExpiresAt).getTime();
    const tick = () => {
      const r = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      setLiveSecsLeft(r);
      if (r <= 0) { clearInterval(liveCountTm.current); liveCountTm.current = null; }
    };
    tick(); liveCountTm.current = setInterval(tick, 1000);
    return () => { if (liveCountTm.current) clearInterval(liveCountTm.current); };
  }, [controller?.activeTrade, controller?.activeTradeExpiresAt]);

  useEffect(() => {
    if (tradeExpTimer.current) { clearTimeout(tradeExpTimer.current); tradeExpTimer.current = null; }
    if (!controller?.activeTrade || !controller?.activeTradeSecondsLeft) return;
    if (controller.activeTradeSecondsLeft <= 0) { setResultPrompt(true); return; }
    tradeExpTimer.current = setTimeout(() => {
      setResultPrompt(true);
      addLog("⏰ Trade expired — record WIN or LOSS", "warn");
    }, controller.activeTradeSecondsLeft * 1000);
    return () => { if (tradeExpTimer.current) clearTimeout(tradeExpTimer.current); };
  }, [controller?.activeTrade, controller?.activeTradeSecondsLeft, addLog]);

  const reportResult = async (result) => {
    const sig = signals.find((s) => !s.noTrade);
    if (!sig) { setResultPrompt(false); return; }
    setResultSubmitting(true);
    try {
      const res  = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportResult: result, pair: sig.pair, direction: sig.direction, confidence: sig.confidence, signalId: sig.id }) });
      const data = await res.json();
      if (data.ok) {
        addLog(`📊 ${result.toUpperCase()} recorded for ${sig.pair}`, result === "win" ? "success" : "error");
        setResultPrompt(false); setController(data.controllerState ?? null);
        setSessionStopped(data.sessionStopped ?? false);
        setSignals([]); setPendingSend(null);
        await loadHistoryFromAPI();
      }
    } catch (err) { addLog(`Result report failed: ${err.message}`, "error"); }
    finally { setResultSubmitting(false); }
  };

  const sendPairToTelegram = async (signal) => {
    setSendingTg(true); setTgStatus(null);
    try {
      addLog(`✈️ Dispatching ${signal.pair} ${signal.direction} to Telegram…`, "info");
      const tgRes = await fetch("/api/telegram", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signals: [signal], dataSource: scanMeta?.dataSource ?? "unknown", isRealData: scanMeta?.isRealData ?? false, blockedCount: scanMeta?.blocked ?? 0, singleMode: true, totalTradeable: signals.filter((s) => !s.noTrade).length }) });
      const tgData = await tgRes.json();
      if (!tgRes.ok || tgData.error) {
        addLog(`Telegram error: ${tgData.error}`, "error");
        if (tgData.hint) addLog(`Hint: ${tgData.hint}`, "warn");
        setTgStatus({ ok: false, msg: tgData.error, hint: tgData.hint });
      } else if (tgData.ok) {
        addLog(`✅ ${signal.pair} sent successfully`, "success");
        setTgStatus({ ok: true, msg: `${signal.pair} dispatched` });
        setPendingSend(null); await lockTrade(signal);
      } else {
        const errStr = (tgData.errors || []).join(", ") || "partial failure";
        addLog(`Telegram error: ${errStr}`, "error"); setTgStatus({ ok: false, msg: errStr });
      }
    } catch (err) { addLog(`Telegram send failed: ${err.message}`, "error"); }
    finally { setSendingTg(false); }
  };

  const lockTrade = async (signal) => {
    try {
      const res  = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockTrade: true, pair: signal.pair, direction: signal.direction, expiry: signal.expiry, confidence: signal.confidence }) });
      const data = await res.json();
      if (data.controllerState) setController(data.controllerState);
      addLog(`🔒 Trade locked — ${signal.pair} ${signal.direction} for ${data.controllerState?.activeTradeSecondsLeft ?? "?"}s`, "success");
    } catch (err) { addLog(`Lock trade failed: ${err.message}`, "error"); }
  };

  const runAnalysis = useCallback(async () => {
    setLoading(true); setSignals([]); setScanMeta(null); setTgStatus(null); setPendingSend(null); setResultPrompt(false);
    try {
      addLog("Initialising SIGNALEX V8.0 scanner…", "info");
      setLoadStep("Layer 1: Market structure…"); await pause(400);
      addLog("Layer 1: trend, S&R zones, breakouts computed", "info");
      setLoadStep("Layer 2: Indicator confluence…"); await pause(350);
      addLog("Layer 2: RSI · MACD · Bollinger · MA crossovers scored", "info");
      setLoadStep("Layer 3: Volatility & session timing…"); await pause(300);
      addLog("Layer 3: ATR volatility, GMT+1 session windows checked", "info");
      setLoadStep("Layer 4: Smart filter + EV model…"); await pause(300);
      addLog("Layer 4: EV + tier scoring applied", "info");
      setLoadStep("Layer 5: Phase classification, quality & expiry…");

      const res  = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.blocked) {
        if (data.reason === "newsBlackout") {
          setNewsBlocked(true);
          setNewsEvent(data.activeNewsEvent ?? null);
          setNewsMinutesLeft(data.minutesLeft ?? 0);
          setNewsNextClear(data.nextClearAt ?? null);
          if (data.upcomingEvents) setNewsCalendar(data.upcomingEvents);
          addLog(`🚫 NEWS BLACKOUT — ${data.activeNewsEvent?.event ?? "High-impact event"} · resumes in ${data.minutesLeft} min`, "warn");
        } else {
          addLog(`⏸ ${data.message}`, data.reason === "sessionStopped" ? "error" : "warn");
        }
        setController(data.controllerState ?? null);
        if (data.sessionStopped) setSessionStopped(true);
        return;
      }
      setNewsBlocked(false);

      const sigs = data.signals || [];
      // BUG FIX: re-derive counts from the FINAL signals array (route.js has a post-assembly
      // quality gate that can demote signals after tradeableCount is set). Trust the signals
      // array itself, not the pre-gate counters from the API response.
      const finalTradeable = sigs.filter((s) => !s.noTrade);
      const finalBlocked   = sigs.filter((s) =>  s.noTrade && s.pair !== "SYSTEM");
      setScanMeta({
        tradeable:   finalTradeable.length,
        blocked:     finalBlocked.length,
        dataSource:  data.dataSource  ?? "unknown",
        isRealData:  data.isRealData  ?? false,
        total:       data.pairsAnalyzed ?? sigs.length,
        demo:        data.demo        ?? false,
        sessionKey:  data.sessionKey  ?? "OFF_HOURS",
        activePairs: data.activePairs ?? [],
        marketMode:  data.marketMode  ?? "forex_otc",
      });
      setSignals(sigs);
      setController(data.controllerState ?? null);
      setSessionStopped(data.controllerState?.sessionStopped ?? false);
      // [KILL-SWITCH-UI] Sync active pauses from API so banner always reflects current state
      setKillSwitchPauses(data.killSwitchPauses ?? []);

      if (data.isRealData) addLog(`✅ LIVE market data — ${data.dataSource}`, "success");
      else addLog("⚠️ Simulated data — start python-backend/main.py for live data", "warn");

      if (finalTradeable.length > 0) {
        const top = finalTradeable[0];
        addLog(`✅ ${top.pair} ${top.direction} · ${top.confidence}% · ${top.strength} · Tier ${top.signalTier || "—"}`, "success");
        setPendingSend(top); setTgPreview(buildPreview(top, 1, finalTradeable.length));

        // V10.0: Capture secondary signals (rank 2+) — add to persistent secondary panel
        // These survive auto-rescan and page refresh. Only user cancel removes them.
        finalTradeable.slice(1).forEach((sec, i) => {
          const secId = sec.id ?? `${sec.pair}_SEC_${Date.now()}_${i}`;
          addSecondarySignal({ ...sec, id: secId, rank: i + 2, capturedAt: Date.now() });
          addLog(`📊 Secondary #${i+2}: ${sec.pair} ${sec.direction} — persisted until cancelled`, "info");
        });
      } else {
        addLog("All pairs filtered — market conditions unfavourable", "warn");
        setTgPreview("No tradeable signals this scan.");
      }
      if (finalBlocked.length > 0)
        addLog(`${finalBlocked.length} pair(s) filtered out`, "warn");
    } catch (err) { addLog(`Error: ${err.message}`, "error"); }
    finally { setLoading(false); setLoadStep(""); }
  }, [addLog, mode, addSecondarySignal]);

  // Auto-rescan: placed HERE (after runAnalysis) so runAnalysis is defined before being
  // referenced in the dependency array — const is not hoisted, referencing it earlier
  // causes "Cannot access before initialization".
  useEffect(() => {
    if (!controller?.activeTrade || !controller?.activeTradeSecondsLeft || !autoRescan) return;
    const ms = (controller.activeTradeSecondsLeft + 60) * 1000;   // V8.0: was 120s → 60s after expiry
    if (rescanTm.current) clearTimeout(rescanTm.current);
    rescanTm.current = setTimeout(() => {
      if (autoRescan) { addLog("🔄 Auto-rescan (1 min after expiry)…", "info"); runAnalysis(); }
    }, ms);
    return () => { if (rescanTm.current) clearTimeout(rescanTm.current); };
  }, [controller?.activeTrade, controller?.activeTradeSecondsLeft, autoRescan, addLog, runAnalysis]);

  const resetSession = async () => {
    try {
      await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resetSession: true }) });
      setController(null); setSignals([]); setPendingSend(null); setResultPrompt(false); setSessionStopped(false);
      addLog("Session reset", "info");
    } catch (err) { addLog(`Reset failed: ${err.message}`, "error"); }
  };

  const clearAllHistory = async () => {
    if (!confirm(t.clearConfirm)) return;
    try {
      await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resetSession: true, clearHistory: true }) });
      setSessionHistory([]); addLog("Session history cleared", "info");
    } catch (err) { addLog(`Clear failed: ${err.message}`, "error"); }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={styles.root}>
      <div className={styles.backdrop} />
      <div className={styles.gridBg} />
      <div className={styles.app}>

        {/* ── HEADER ── */}
        <header
          className={styles.header}
          style={{
            borderColor: controlState?.account === "real" ? "rgba(209,52,56,0.4)" : "rgba(0,120,212,0.3)",
            background: controlState?.account === "real" ? "rgba(209,52,56,0.06)" : "transparent",
            borderRadius: 10,
            padding: "12px 18px",
            transition: "all 0.3s ease",
          }}
        >
          <div className={styles.logo}>
            <div className={styles.logoMark}>
              <span className={styles.logoMarkText}>SX</span>
            </div>
            <div>
              <div className={styles.logoName}>
                SIGNALEX <span className={styles.logoVersion}>V10.0</span>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: 1,
                    padding: "2px 8px",
                    borderRadius: 4,
                    background: controlState?.account === "real" ? "#d13438" : "#0078d4",
                    color: "#fff",
                    boxShadow: controlState?.account === "real" ? "0 0 10px rgba(209,52,56,0.4)" : "0 0 10px rgba(0,120,212,0.3)",
                    marginLeft: 6,
                  }}
                >
                  {controlState?.account === "real" ? "🔥 REAL" : "🛡️ DEMO"}
                </span>
              </div>
              {/* Suppress hydration warning on sub-line — it uses t.appSub which differs by lang */}
              <div className={styles.logoSub} suppressHydrationWarning>{mounted ? t.appSub : T.en.appSub}</div>
            </div>
          </div>

          <div className={styles.headerRight}>
            {/* Language toggle */}
            <button
              onClick={switchLang}
              className={styles.langToggle}
              suppressHydrationWarning
            >
              🌐 {mounted ? t.langBtn : T.en.langBtn}
            </button>

            {/* V8.0: Backend health indicator in header */}
            {healthStatus && (
              <div className={`${styles.chip} ${healthStatus.backendOnline ? styles.chipSuccess : styles.chipError}`}>
                {healthStatus.backendOnline ? "⚙️ Backend OK" : "⚙️ Backend DOWN"}
              </div>
            )}

            {/* Status chips */}
            {scanMeta?.isRealData && (
              <div className={`${styles.chip} ${styles.chipSuccess}`} suppressHydrationWarning>
                {t.liveData}
              </div>
            )}
            {scanMeta && !scanMeta.isRealData && (
              <div className={`${styles.chip} ${styles.chipWarning}`} suppressHydrationWarning>
                {t.simulated}
              </div>
            )}
            {tradeActive && (
              <div className={`${styles.chip} ${styles.chipError}`}>
                🔒 {tradeSecsLeft > 0 ? `${tradeSecsLeft}s` : "EXPIRED"}
              </div>
            )}

            {/* Status dot */}
            <div className={styles.statusDot}>
              <span className={`${styles.dot} ${loading ? styles.dotPulse : tradeActive ? styles.dotLocked : styles.dotReady}`} />
              <span className={styles.statusText} suppressHydrationWarning>
                {loading ? t.scanning : tradeActive ? t.locked : t.ready}
              </span>
            </div>

            <div className={styles.clock}>{time}</div>
          </div>
        </header>

        {/* ── TABS ── */}
        <nav className={styles.tabBar}>
          {/* Hamburger button — visible only at 277-469px */}
          <button
            className={styles.hamburger}
            aria-label="Open navigation menu"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(o => !o)}
          >
            <span className={`${styles.hamburgerLine} ${mobileNavOpen ? styles.hlTop : ""}`} />
            <span className={`${styles.hamburgerLine} ${mobileNavOpen ? styles.hlMid : ""}`} />
            <span className={`${styles.hamburgerLine} ${mobileNavOpen ? styles.hlBot : ""}`} />
          </button>

          {/* Active tab name shown beside hamburger */}
          <span className={styles.mobileActiveLabel} suppressHydrationWarning>
            {mounted ? t[TAB_KEYS[tab]] : T.en[TAB_KEYS[tab]]}
          </span>

          {/* Desktop: full tab row */}
          <div className={styles.tabBtns}>
            {TAB_KEYS.map((key, i) => (
              <button
                key={key}
                className={`${styles.tabBtn} ${tab === i ? styles.tabBtnActive : ""}`}
                onClick={() => setTab(i)}
                suppressHydrationWarning
              >
                {mounted ? t[key] : T.en[key]}
                {key === "tabSession" && sessionHistory.length > 0 && (
                  <span className={styles.tabBadge}>{sessionHistory.length}</span>
                )}
              </button>
            ))}
          </div>

          {/* Mobile slide-down drawer */}
          <div className={`${styles.mobileDrawer} ${mobileNavOpen ? styles.mobileDrawerOpen : ""}`}>
            {TAB_KEYS.map((key, i) => (
              <button
                key={key}
                className={`${styles.mobileNavItem} ${tab === i ? styles.mobileNavItemActive : ""}`}
                onClick={() => { setTab(i); setMobileNavOpen(false); }}
                suppressHydrationWarning
              >
                {mounted ? t[key] : T.en[key]}
                {key === "tabSession" && sessionHistory.length > 0 && (
                  <span className={styles.tabBadge}>{sessionHistory.length}</span>
                )}
              </button>
            ))}
          </div>
        </nav>

        {/* Tap-outside backdrop */}
        {mobileNavOpen && (
          <div className={styles.mobileBackdrop} onClick={() => setMobileNavOpen(false)} />
        )}

        {/* ════ DASHBOARD ════ */}
        {tab === 0 && (
          <div className={styles.tabContent}>
            {/* Top Pause Banner when paused */}
            {controlState?.trading_paused && (
              <PauseBanner
                pauseReason={controlState?.pause_reason}
                onResume={(newState) => {
                  setControlState((prev) => ({
                    ...prev,
                    ...newState,
                    trading_paused: false,
                    pause_reason: null,
                  }));
                }}
              />
            )}

            {/* Control Bar (Mode Buttons, Account Switcher, Kill Switch, Status Chips) */}
            <ControlBar
              controlState={controlState}
              onStateUpdate={(newState) => {
                setControlState((prev) => ({ ...prev, ...newState }));
              }}
              onOpenSettings={() => setSettingsOpen(true)}
            />

            {/* Pending confirmation card (SEMI mode) */}
            {pendingList && pendingList.length > 0 && (
              <PendingTradeCard
                pendingList={pendingList}
                onRefresh={fetchPending}
              />
            )}

            {/* Stats row */}
            {scanMeta && (
              <div className={styles.statsRow}>
                {[
                  { label: t.pairsScanned, value: scanMeta.total,     accent: CLR.accent },
                  { label: t.tradeable,     value: scanMeta.tradeable, accent: CLR.success },
                  { label: t.filteredOut,   value: scanMeta.blocked,   accent: CLR.error },
                  { label: t.avgConfidence, value: tradeable.length ? `${Math.round(tradeable.reduce((a,s) => a+s.confidence, 0)/tradeable.length)}%` : "—", accent: CLR.warning },
                  { label: t.dataSource,    value: String(scanMeta.dataSource).replace(/_/g," ").toUpperCase(), accent: "rgba(255,255,255,0.5)", small: true },
                ].map((s) => (
                  <div key={s.label} className={styles.statCard}>
                    <div className={styles.statCardAccent} style={{ background: s.accent }} />
                    <div className={styles.statLabel}>{s.label}</div>
                    <div className={styles.statValue} style={{ color: s.accent, fontSize: s.small ? 13 : undefined }}>{s.value}</div>
                  </div>
                ))}
              </div>
            )}

            {/* ── V7.0.3 NEWS BLACKOUT BANNER ── */}
            {newsBlocked && newsEvent && (
              <div className={styles.newsBanner}>
                <div className={styles.newsIcon}>📰</div>
                <div className={styles.newsBody}>
                  <div className={styles.newsTitle} suppressHydrationWarning>
                    {t.newsBlackout}
                  </div>
                  <div className={styles.newsSub}>
                    <strong>{newsEvent.currency}</strong> — {newsEvent.event}
                  </div>
                  <div className={styles.newsTimer} suppressHydrationWarning>
                    {t.newsBlackoutSub(newsEvent.event, newsMinutesLeft)}
                  </div>
                </div>
                <button
                  className={`${styles.btn} ${styles.btnGhost}`}
                  onClick={() => fetchNewsCalendar(true)}
                  disabled={newsLoading}
                  suppressHydrationWarning
                >
                  {newsLoading ? "…" : t.newsRefresh}
                </button>
              </div>
            )}

            {/* Session-stopped alert */}
            {sessionStopped && (
              <div className={`${styles.alert} ${styles.alertError}`}>
                <div className={styles.alertIcon}>🛑</div>
                <div className={styles.alertBody}>
                  <div className={styles.alertTitle} suppressHydrationWarning>{t.sessionStopped}</div>
                  <div className={styles.alertSub} suppressHydrationWarning>
                    {t.sessionStoppedMsg(controller?.sessionLog?.consecutiveLosses ?? 2)}
                  </div>
                  <div className={styles.alertSub} style={{ opacity: 0.6 }} suppressHydrationWarning>{t.resumeSession}</div>
                </div>
                <button className={`${styles.btn} ${styles.btnDanger}`} onClick={resetSession} suppressHydrationWarning>
                  {t.resetSession}
                </button>
              </div>
            )}

            {/* [KILL-SWITCH-UI] Kill-switch pause banner — shows whenever any pair or the session is paused due to CHAOTIC market */}
            {killSwitchPauses.length > 0 && (
              <div className={`${styles.alert} ${styles.alertWarning}`} style={{ borderLeft: "4px solid #f59e0b" }}>
                <div className={styles.alertIcon}>⚠️</div>
                <div className={styles.alertBody} style={{ flex: 1 }}>
                  <div className={styles.alertTitle} suppressHydrationWarning>
                    {killSwitchPauses.some(p => p.target === "SESSION")
                      ? "Session paused — CHAOTIC market detected"
                      : "Pair(s) temporarily paused — CHAOTIC market"}
                  </div>
                  {killSwitchPauses.map((pause) => (
                    <div key={pause.target} className={styles.alertSub} style={{ marginTop: 4 }} suppressHydrationWarning>
                      <strong>{pause.target === "SESSION" ? "All pairs" : pause.target}</strong>
                      {" · resumes in "}
                      <strong>{Math.ceil(pause.remainingSecs / 60)} min</strong>
                      <span style={{ opacity: 0.6, fontSize: "0.78em", marginLeft: 6 }}>
                        ({pause.reason})
                      </span>
                    </div>
                  ))}
                  <div className={styles.alertSub} style={{ opacity: 0.55, marginTop: 6, fontSize: "0.78em" }} suppressHydrationWarning>
                    Engine auto-resumes when pause expires. No action needed.
                  </div>
                </div>
              </div>
            )}

            {/* WIN/LOSS persistent prompt */}
            {resultPrompt && topSignal && (
              <div className={`${styles.alert} ${styles.alertWarning}`}>
                <div className={styles.alertIcon}>🏁</div>
                <div className={styles.alertBody}>
                  <div className={styles.alertTitle} suppressHydrationWarning>{t.tradeExpired}</div>
                  <div className={styles.alertPair}>
                    {topSignal.pair}{" "}
                    <span style={{ color: topSignal.direction === "BUY" ? CLR.success : CLR.error }}>
                      {topSignal.direction}
                    </span>
                  </div>
                  <div className={styles.alertSub} suppressHydrationWarning>{t.recordResult}</div>
                </div>
                <div className={styles.alertActions}>
                  <button className={`${styles.btn} ${styles.btnSuccess}`} disabled={resultSubmitting} onClick={() => reportResult("win")} suppressHydrationWarning>
                    ✅ {t.win}
                  </button>
                  <button className={`${styles.btn} ${styles.btnDanger}`}  disabled={resultSubmitting} onClick={() => reportResult("loss")} suppressHydrationWarning>
                    ❌ {t.loss}
                  </button>
                  <button className={`${styles.btn} ${styles.btnGhost}`}   disabled={resultSubmitting} onClick={() => setResultPrompt(false)} title="Close without recording">✕</button>
                </div>
              </div>
            )}

            {/* Active trade */}
            {tradeActive && !resultPrompt && topSignal && (
              <div className={`${styles.alert} ${styles.alertAccent}`}>
                <div className={styles.alertIcon}>🔒</div>
                <div className={styles.alertBody}>
                  <div className={styles.alertTitle} suppressHydrationWarning>{t.tradeInProgress}</div>
                  <div className={styles.alertPair}>
                    {topSignal.pair}{" "}
                    <span style={{ color: topSignal.direction === "BUY" ? CLR.success : CLR.error }}>
                      {topSignal.direction}
                    </span>
                  </div>
                  {tradeSecsLeft > 0 && (
                    <div className={styles.alertSub} suppressHydrationWarning>{t.expiresIn} {tradeSecsLeft}s</div>
                  )}
                </div>
                <div className={styles.alertSub} style={{ maxWidth: 180, textAlign: "right" }} suppressHydrationWarning>
                  {t.winLossPrompt}
                </div>
              </div>
            )}

            {/* Telegram dispatch */}
            {pendingSend && !tradeActive && !loading && !sessionStopped && (
              <div className={`${styles.alert} ${styles.alertSuccess}`}>
                <div className={styles.alertIcon}>📡</div>
                <div className={styles.alertBody}>
                  <div className={styles.alertTitle} suppressHydrationWarning>{t.scanComplete}</div>
                  <div className={styles.alertPair}>
                    {pendingSend.pair}{" "}
                    <span style={{ color: pendingSend.direction === "BUY" ? CLR.success : CLR.error }}>
                      {pendingSend.direction}
                    </span>
                  </div>
                  <div className={styles.alertSub} style={{ color: CLR.success }}>
                    {pendingSend.confidence}% · {pendingSend.strength} · {pendingSend.expiry}
                  </div>
                </div>
                <div className={styles.alertActions}>
                  <button className={`${styles.btn} ${styles.btnAccent}`} disabled={sendingTg} onClick={() => sendPairToTelegram(pendingSend)} suppressHydrationWarning>
                    ✈️ {sendingTg ? t.sending : t.sendTelegram}
                  </button>
                  <button className={`${styles.btn} ${styles.btnGhost}`}  disabled={sendingTg} onClick={() => setPendingSend(null)} suppressHydrationWarning>
                    {t.skip}
                  </button>
                </div>
              </div>
            )}

            {/* Scan controls */}
            <div className={styles.controls}>
              <div className={styles.filterGroup}>
                {[t.filterAll, t.filterOtc, t.filterForex].map((label, i) => {
                  const val = ["all", "otc", "forex"][i];
                  return (
                    <button
                      key={val}
                      className={`${styles.filterBtn} ${mode === val ? styles.filterBtnActive : ""}`}
                      onClick={() => setMode(val)}
                      disabled={loading || tradeActive}
                      suppressHydrationWarning
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              <button
                className={`${styles.runBtn} ${loading ? styles.runBtnLoading : ""} ${newsBlocked ? styles.runBtnNews : ""}`}
                onClick={runAnalysis}
                disabled={loading || tradeActive || sessionStopped || newsBlocked}
                suppressHydrationWarning
              >
                {loading ? (
                  <><span className={styles.spinner} /> {loadStep || t.scanning}</>
                ) : tradeActive    ? `🔒 ${t.tradeActive} (${tradeSecsLeft}s)`
                  : sessionStopped ? `🛑 ${t.sessionStopped}`
                  : newsBlocked    ? `📰 News blackout — ${newsMinutesLeft}m`
                  : `▶ ${t.runAnalysis}`}
              </button>

              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={autoRescan}
                  onChange={(e) => setAutoRescan(e.target.checked)}
                  className={styles.checkInput}
                />
                <span suppressHydrationWarning>{t.autoRescan}</span>
              </label>
            </div>

            {/* Tradeable signals — top 3, only #1 goes to Telegram */}
            {tradeable.length > 0 && (
              <section className={styles.section}>
                <h2 className={styles.sectionHead}>
                  <span className={styles.sectionDot} style={{ background: CLR.success }} />
                  <span suppressHydrationWarning>{t.tradeableSignals}</span>
                  <span className={styles.sectionCount} style={{ color: CLR.success }}>{tradeable.length}</span>
                  {tradeable.length > 1 && (
                    <span style={{ color: CLR.textSecondary, fontSize: 10, marginLeft: 8, fontFamily: "var(--font-data)", letterSpacing: 1 }}>
                      · #1 DISPATCHED TO TELEGRAM · #2–3 FOR CONTEXT ONLY
                    </span>
                  )}
                  {/* P4: Session label */}
                  {controller?.sessionKey && controller.sessionKey !== "OFF_HOURS" && (
                    <span style={{
                      marginLeft: 10, fontSize: 10, color: CLR.accent,
                      background: "rgba(0,120,212,0.15)", borderRadius: 4,
                      padding: "2px 7px", fontWeight: 700, letterSpacing: 1,
                    }}>
                      🕐 {controller.sessionKey} SESSION
                    </span>
                  )}
                </h2>
                <div className={styles.cardGrid}>
                  {tradeable.slice(0, 3).map((s, i) => (
                    <SignalCard key={s.pair + i} signal={s} rank={i + 1} delay={i * 80} t={t} isPrimary={i === 0}
                      onManualExecute={i > 0 ? async (id, action, result) => {
                        try {
                          const res = await fetch("/api/manual-execute", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id, action, result }),
                          });
                          const data = await res.json();
                          if (data.ok) {
                            addLog(`✅ SECONDARY ${action === "execute" ? "executed" : "result=" + result} for ${s.pair}`, "success");
                          } else {
                            addLog(`❌ Manual ${action} failed: ${data.error}`, "error");
                          }
                        } catch (err) {
                          addLog(`❌ Manual execute error: ${err.message}`, "error");
                        }
                      } : null}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Filtered pairs */}
            {blocked.length > 0 && (
              <section className={styles.section}>
                <h2 className={styles.sectionHead}>
                  <span className={styles.sectionDot} style={{ background: CLR.error }} />
                  <span suppressHydrationWarning>{t.filteredOutSec}</span>
                  <span className={styles.sectionCount} style={{ color: CLR.error }}>{blocked.length}</span>
                </h2>
                <div className={styles.blockedGrid}>
                  {blocked.map((s) => (
                    <div key={s.pair + (s.noTradeReasons?.[0] || "")} className={styles.blockedChip}>
                      <span className={styles.blockedPair}>{s.pair}</span>
                      <span className={styles.blockedReason}>
                        {(s.noTradeReasons || ["Conditions unfavourable"])[0]}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}


            {/* ── V10.0: Persistent Secondary Signals Panel ─────────────────────── */}
            {secondarySignals.length > 0 && (
              <section className={styles.section} style={{ border: `1px solid rgba(255,170,68,0.25)`, borderRadius: 10, padding: "14px 14px 10px" }}>
                <h2 className={styles.sectionHead} style={{ marginBottom: 10 }}>
                  <span className={styles.sectionDot} style={{ background: CLR.warning }} />
                  <span style={{ color: CLR.warning, fontWeight: 700 }}>📊 SECONDARY SIGNALS</span>
                  <span style={{ fontSize: 11, color: CLR.textSecondary, marginLeft: 8 }}>— Persist until manually cancelled</span>
                  <span className={styles.sectionCount} style={{ color: CLR.warning }}>{secondarySignals.filter(s => s.status !== "DONE").length}</span>
                </h2>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {secondarySignals.map((sec) => (
                    <div key={sec.id} style={{
                      background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "12px 14px",
                      border: sec.result === "WIN" ? `1px solid ${CLR.success}` : sec.result === "LOSS" ? `1px solid ${CLR.error}` : "1px solid rgba(255,170,68,0.20)",
                      opacity: sec.status === "DONE" ? 0.65 : 1,
                    }}>
                      {/* Header row */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                        <span style={{ fontSize: 10, fontWeight: 800, color: CLR.warning, background: "rgba(255,170,68,0.15)", padding: "2px 7px", borderRadius: 4 }}>
                          #{sec.rank ?? "?"}
                        </span>
                        <span style={{ fontWeight: 700, color: CLR.textPrimary, fontSize: 14 }}>{sec.pair}</span>
                        <span style={{
                          fontWeight: 800, fontSize: 11, padding: "2px 8px", borderRadius: 4,
                          color: sec.direction === "BUY" ? CLR.success : CLR.error,
                          background: sec.direction === "BUY" ? CLR.successBg : CLR.errorBg,
                        }}>
                          {sec.direction === "BUY" ? "▲ BUY" : "▼ SELL"}
                        </span>
                        <span style={{ fontSize: 11, color: CLR.textSecondary }}>{sec.confidence}% conf</span>
                        {sec.expiry && <span style={{ fontSize: 11, color: CLR.warning }}>⏳ {sec.expiry}</span>}
                        {sec.result && (
                          <span style={{
                            fontWeight: 800, fontSize: 11, padding: "2px 8px", borderRadius: 4,
                            color: sec.result === "WIN" ? CLR.success : CLR.error,
                            background: sec.result === "WIN" ? CLR.successBg : CLR.errorBg,
                          }}>
                            {sec.result === "WIN" ? "✅ WIN" : "❌ LOSS"}
                          </span>
                        )}
                        {/* Cancel button — always visible, only way to remove */}
                        <button
                          onClick={() => cancelSecondarySignal(sec.id)}
                          style={{
                            marginLeft: "auto", padding: "3px 10px", borderRadius: 5, cursor: "pointer",
                            background: "rgba(209,52,56,0.12)", border: "1px solid rgba(209,52,56,0.35)",
                            color: CLR.error, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap",
                            minWidth: 44, minHeight: 32,
                          }}
                        >✕ CANCEL</button>
                      </div>
                      {/* Action buttons — only show if not done */}
                      {sec.status !== "DONE" && (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button
                            onClick={() => markSecondaryResult(sec.id, "WIN")}
                            style={{
                              flex: 1, minWidth: 80, minHeight: 36, padding: "6px 10px", borderRadius: 6,
                              background: CLR.successBg, border: `1px solid ${CLR.success}`,
                              color: CLR.success, fontWeight: 800, fontSize: 12, cursor: "pointer",
                            }}
                          >✅ WIN</button>
                          <button
                            onClick={() => markSecondaryResult(sec.id, "LOSS")}
                            style={{
                              flex: 1, minWidth: 80, minHeight: 36, padding: "6px 10px", borderRadius: 6,
                              background: CLR.errorBg, border: `1px solid ${CLR.error}`,
                              color: CLR.error, fontWeight: 800, fontSize: 12, cursor: "pointer",
                            }}
                          >❌ LOSS</button>
                          <div style={{ fontSize: 10, color: CLR.textSecondary, display: "flex", alignItems: "center", padding: "0 4px" }}>
                            Manual — not counted in session stats
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── V10.0: Market Forecast Panel ──────────────────────────────────── */}
            <section className={styles.section} style={{ border: `1px solid rgba(0,120,212,0.20)`, borderRadius: 10, padding: "14px 14px 10px" }}>
              {/* Header */}
              <div
                style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: forecastOpen ? 14 : 0, flexWrap: "wrap" }}
                onClick={() => setForecastOpen(o => !o)}
              >
                <span className={styles.sectionDot} style={{ background: CLR.accent }} />
                <span style={{ fontWeight: 700, color: CLR.accent, fontSize: 14 }}>📡 MARKET FORECAST</span>
                <span style={{ fontSize: 10, color: CLR.textSecondary, marginLeft: 4 }}>30-min live analysis</span>
                {forecastData?.last_run_age_secs !== null && forecastData?.last_run_age_secs !== undefined && (
                  <span style={{ fontSize: 10, color: CLR.textSecondary, marginLeft: "auto" }}>
                    Updated {Math.round((forecastData.last_run_age_secs ?? 0) / 60)}m ago
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); fetchForecast(true); }}
                  disabled={forecastLoading}
                  style={{
                    padding: "3px 10px", borderRadius: 5, background: CLR.accentLight,
                    border: `1px solid ${CLR.accent}`, color: CLR.accent,
                    fontSize: 11, fontWeight: 700, cursor: "pointer", minHeight: 32, minWidth: 44,
                  }}
                >
                  {forecastLoading ? "⟳" : "↻ Refresh"}
                </button>
                <span style={{ fontSize: 12, color: CLR.textSecondary }}>{forecastOpen ? "▲" : "▼"}</span>
              </div>

              {forecastOpen && (
                <>
                  {/* Overall market score */}
                  {forecastData?.daily_outlook && (() => {
                    const o = forecastData.daily_outlook;
                    const scoreColor = o.overallScore >= 65 ? CLR.success : o.overallScore >= 40 ? CLR.warning : CLR.error;
                    return (
                      <div style={{
                        background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "12px 14px",
                        marginBottom: 12, border: `1px solid rgba(255,255,255,0.08)`,
                      }}>
                        {/* Score row */}
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{
                              width: 56, height: 56, borderRadius: "50%",
                              background: `conic-gradient(${scoreColor} ${o.overallScore * 3.6}deg, rgba(255,255,255,0.08) 0deg)`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              position: "relative",
                            }}>
                              <div style={{
                                width: 44, height: 44, borderRadius: "50%",
                                background: "#16213e", display: "flex", alignItems: "center", justifyContent: "center",
                                fontWeight: 800, fontSize: 15, color: scoreColor,
                              }}>{o.overallScore}</div>
                            </div>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: 13, color: CLR.textPrimary }}>
                                {o.overallState === "NORMAL" ? "🟢" : o.overallState === "VOLATILE" ? "🟡" : "🔴"} {o.overallState}
                              </div>
                              <div style={{ fontSize: 11, color: CLR.textSecondary, maxWidth: 280 }}>{o.overallLabel}</div>
                            </div>
                          </div>
                          <div style={{ marginLeft: "auto", fontSize: 10, color: CLR.textSecondary, textAlign: "right" }}>
                            <div>📈 {o.pairSummary?.normal ?? 0} normal · ⚠️ {o.pairSummary?.volatile ?? 0} volatile · 🔴 {o.pairSummary?.chaotic ?? 0} chaotic</div>
                            <div>ATR: {o.avgATR} · {o.scheduledNewsCount ?? 0} scheduled news today</div>
                          </div>
                        </div>

                        {/* Per-session outlook */}
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 6 }}>
                          {(o.sessionOutlooks ?? []).map((s) => {
                            const bg = s.isActive ? "rgba(0,120,212,0.12)" : "rgba(255,255,255,0.03)";
                            const bc = s.isActive ? CLR.accent : "rgba(255,255,255,0.08)";
                            const sc = s.state === "NORMAL" ? CLR.success : s.state === "VOLATILE" ? CLR.warning : CLR.error;
                            return (
                              <div key={s.key} style={{ background: bg, border: `1px solid ${bc}`, borderRadius: 6, padding: "8px 10px" }}>
                                <div style={{ fontWeight: 700, fontSize: 11, color: CLR.textPrimary, marginBottom: 2 }}>
                                  {s.statusIcon} {s.label}
                                  {s.isActive && <span style={{ color: CLR.accent, marginLeft: 4, fontSize: 9 }}>LIVE</span>}
                                </div>
                                <div style={{ fontSize: 10, color: sc, fontWeight: 700 }}>{s.state} · {s.score}/100</div>
                                <div style={{ fontSize: 9, color: CLR.textSecondary, marginTop: 2 }}>{s.timeStatus}</div>
                                {s.newsRisk && <div style={{ fontSize: 9, color: CLR.warning, marginTop: 2 }}>⚠️ News risk</div>}
                                <div style={{ fontSize: 9, color: CLR.textSecondary, marginTop: 2, lineHeight: 1.3 }}>{s.recommendation}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Per-pair forecast grid */}
                  {forecastData?.forecasts && Object.keys(forecastData.forecasts).length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 6 }}>
                      {Object.values(forecastData.forecasts).map((f) => {
                        const stateColor = f.market_state === "NORMAL" ? CLR.success : f.market_state === "VOLATILE" ? CLR.warning : CLR.error;
                        const icon       = f.market_state === "NORMAL" ? "🟢" : f.market_state === "VOLATILE" ? "🟡" : "🔴";
                        return (
                          <div key={f.pair} style={{
                            background: "rgba(255,255,255,0.03)", borderRadius: 6, padding: "8px 10px",
                            border: `1px solid rgba(255,255,255,0.07)`,
                          }}>
                            <div style={{ fontWeight: 700, fontSize: 11, color: CLR.textPrimary, marginBottom: 3 }}>
                              {icon} {f.pair}
                            </div>
                            <div style={{ fontSize: 10, color: stateColor, fontWeight: 700 }}>{f.market_state}</div>
                            <div style={{ fontSize: 9, color: CLR.textSecondary, marginTop: 2 }}>{f.recommendation}</div>
                            {f.risk_type !== "NONE" && (
                              <div style={{ fontSize: 9, color: CLR.warning, marginTop: 2 }}>⚠️ {f.risk_type?.replace(/_/g," ")}</div>
                            )}
                            <div style={{ fontSize: 9, color: CLR.textDisabled, marginTop: 2 }}>
                              {Math.round((f.confidence ?? 0) * 100)}% confidence
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {!forecastData && !forecastLoading && (
                    <div style={{ textAlign: "center", color: CLR.textSecondary, fontSize: 12, padding: "20px 0" }}>
                      No forecast data yet — click ↻ Refresh or wait for next 30-min cycle
                    </div>
                  )}
                  {forecastLoading && (
                    <div style={{ textAlign: "center", color: CLR.accent, fontSize: 12, padding: "20px 0" }}>
                      ⟳ Fetching live market data...
                    </div>
                  )}
                </>
              )}
            </section>

            {/* Empty state */}
            {!loading && signals.length === 0 && !scanMeta && (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>⚡</div>
                <div className={styles.emptyTitle} suppressHydrationWarning>{t.readyToScan}</div>
                <div className={styles.emptySub} suppressHydrationWarning>{t.clickRun}</div>
              </div>
            )}

            {/* Activity log */}
            {logs.length > 0 && (
              <div className={styles.logPanel}>
                <div className={styles.logHead} suppressHydrationWarning>{t.activityLog}</div>
                <div className={styles.logBody} ref={logRef}>
                  {logs.map((l, i) => (
                    <div key={i} className={`${styles.logLine} ${{ info: styles.log_info, success: styles.log_success, warn: styles.log_warn, error: styles.log_error }[l.type] ?? styles.log_info}`}>
                      <span className={styles.logTs}>{l.ts}</span>
                      <span className={styles.logMsg}>{l.msg}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ════ TRADES ════ */}
        {tab === 1 && (
          <div className={styles.tabContent}>
            <TradesTable />
          </div>
        )}

        {/* ════ STATS ════ */}
        {tab === 2 && (
          <div className={styles.tabContent}>
            <StatsPanel />
          </div>
        )}

        {/* ════ SESSION ════ */}
        {tab === 3 && (
          <div className={styles.twoCol}>
            <div className={styles.card2}>
              <div className={styles.card2Head}>
                <span suppressHydrationWarning>{t.currentSession}</span>
                <button className={`${styles.btn} ${styles.btnDanger}`} style={{ padding: "5px 14px" }} onClick={resetSession} suppressHydrationWarning>
                  {t.resetSession}
                </button>
              </div>
              <SessionStats controller={controller} t={t} />
            </div>
            <div className={styles.card2}>
              <div className={styles.card2Head}>
                <span suppressHydrationWarning>{t.sessionHistory} ({sessionHistory.length})</span>
                {sessionHistory.length > 0 && (
                  <button className={`${styles.btn} ${styles.btnGhost}`} style={{ padding: "5px 14px" }} onClick={clearAllHistory} suppressHydrationWarning>
                    {t.clearAll}
                  </button>
                )}
              </div>
              {!historyLoaded && <div className={styles.dimText} suppressHydrationWarning>{t.loadingHistory}</div>}
              {historyLoaded && sessionHistory.length === 0 && (
                <div className={styles.dimText} style={{ padding: "20px 0" }} suppressHydrationWarning>{t.noHistory}</div>
              )}
              {sessionHistory.map((s, i) => <HistoryCard key={(s.startedAt || "") + i} session={s} />)}
            </div>
          </div>
        )}

        {/* ════ CONFIGURE ════ */}
        {tab === 4 && (
          <div className={styles.configGrid}>
            {/* Backend status */}
            <div className={styles.card2}>
              <div className={styles.card2Head}><span suppressHydrationWarning>{t.backendStatus}</span></div>
              {[
                [t.pythonBackend, "http://localhost:8000"],
                ["Data Source",   scanMeta?.marketMode ? (scanMeta.dataSource ?? "—") : "—"],
                [t.marketMode,    scanMeta?.marketMode ?? "—"],
                [t.session,       scanMeta?.sessionKey ?? "—"],
                [t.activePairs,   scanMeta?.activePairs?.join(", ") || "—"],
              ].map(([k, v]) => (
                <div key={k} className={styles.kvRow}>
                  <span className={styles.kvKey} suppressHydrationWarning>{k}</span>
                  <span className={styles.kvVal}>{v}</span>
                </div>
              ))}
              <div style={{ marginTop: 14 }}>
                <a
                  href="http://localhost:8000/test"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${styles.btn} ${styles.btnGhost}`}
                  style={{ display: "inline-block", fontSize: 12, padding: "5px 14px", textDecoration: "none" }}
                >
                  🔗 Test all data sources →
                </a>
                <a
                  href="http://localhost:8000/source"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${styles.btn} ${styles.btnGhost}`}
                  style={{ display: "inline-block", fontSize: 12, padding: "5px 14px", textDecoration: "none", marginLeft: 8 }}
                >
                  📊 Source per pair →
                </a>
              </div>
              <div className={styles.infoBox} style={{ marginTop: 16 }}>
                <div className={styles.infoTitle} suppressHydrationWarning>{t.betaCalib}</div>
                <div className={styles.infoText} suppressHydrationWarning>{t.betaCalibText}</div>
              </div>
            </div>

            {/* Environment variables */}
            <div className={styles.card2}>
              <div className={styles.card2Head}><span suppressHydrationWarning>{t.envVars}</span></div>
              {[
                ["POLYGON_API_KEY",        "python-backend/.env — PRIMARY source (real-time forex)"],
                ["TELEGRAM_BOT_TOKEN",     ".env.local"],
                ["TELEGRAM_CHAT_ID",       ".env.local"],
                ["PYTHON_BACKEND_URL",     "optional — default localhost:8000"],
                ["TWELVE_DATA_API_KEY",    "optional — python-backend/.env (2nd fallback)"],
                ["ALPHA_VANTAGE_KEY",      "optional — python-backend/.env (3rd fallback)"],
                ["NEWS_BLACKOUT_MINUTES",  "optional — default 15 (minutes before/after events)"],
              ].map(([k, v]) => (
                <div key={k} className={styles.kvRow}>
                  <span className={styles.kvKey}>{k}</span>
                  <span className={styles.kvVal}>{v}</span>
                </div>
              ))}
            </div>

            {/* V7.0.3: News calendar — full-width row */}
            <div className={`${styles.card2} ${styles.configFull}`}>
              <div className={styles.card2Head}>
                <span suppressHydrationWarning>{t.newsCalendar}</span>
                <button
                  className={`${styles.btn} ${styles.btnGhost}`}
                  style={{ padding: "4px 12px", fontSize: 12 }}
                  onClick={() => fetchNewsCalendar(true)}
                  disabled={newsLoading}
                  suppressHydrationWarning
                >
                  {newsLoading ? "…" : t.newsRefresh}
                </button>
              </div>

              {newsBlocked && newsEvent && (
                <div className={styles.newsCalBanner}>
                  📰 <strong>BLACKOUT ACTIVE</strong> — {newsEvent.currency} {newsEvent.event}
                  {newsMinutesLeft > 0 && <span style={{ color: CLR.warning }}> · {newsMinutesLeft} min remaining</span>}
                </div>
              )}

              {newsLoading && newsCalendar.length === 0 && (
                <div className={styles.dimText} suppressHydrationWarning>{t.newsLoading}</div>
              )}

              {!newsLoading && newsCalendar.length === 0 && (
                <div className={styles.dimText} suppressHydrationWarning>{t.newsCalendarEmpty}</div>
              )}

              {newsCalendar.length > 0 && (
                <div className={styles.newsTable}>
                  <div className={styles.newsTableHead}>
                    <span>TIME (UTC)</span>
                    <span>CCY</span>
                    <span>EVENT</span>
                    <span>BLACKOUT</span>
                    <span>SOURCE</span>
                  </div>
                  {newsCalendar.map((evt, i) => {
                    const evtTime  = new Date(evt.timestamp);
                    const now      = Date.now();
                    const distMs   = evt.timestamp - now;
                    const blackMs  = 15 * 60 * 1000;
                    const isActive = Math.abs(distMs) <= blackMs;
                    const isPast   = distMs < -blackMs;
                    const timeStr  = evtTime.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
                    const fromStr  = distMs > 0
                      ? `in ${Math.ceil(distMs / 60000)} min`
                      : `${Math.ceil(-distMs / 60000)} min ago`;
                    return (
                      <div
                        key={i}
                        className={`${styles.newsTableRow} ${isActive ? styles.newsRowActive : ""} ${isPast ? styles.newsRowPast : ""}`}
                      >
                        <span className={styles.newsTime}>{timeStr} UTC</span>
                        <span className={styles.newsCcy} style={{ color: CLR.warning }}>{evt.currency}</span>
                        <span className={styles.newsEvt}>{evt.event}</span>
                        <span className={styles.newsWindow} style={{ color: isActive ? CLR.error : CLR.textSecondary }}>
                          {isActive ? "🔴 ACTIVE" : isPast ? "✅ Passed" : `±15 min (${fromStr})`}
                        </span>
                        <span className={styles.newsSrc}>{evt.source}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className={styles.infoBox} style={{ marginTop: 16, borderColor: "rgba(0,120,212,0.2)", background: "rgba(0,120,212,0.05)" }}>
                <div className={styles.infoTitle} style={{ color: CLR.accent }}>HOW NEWS BLACKOUT WORKS</div>
                <div className={styles.infoText}>
                  Signal generation is automatically blocked 15 minutes before and 15 minutes after any high-impact economic event for USD, EUR, GBP, JPY, AUD, CAD, CHF, and NZD.
                  Sources: Finnhub (primary) → ForexFactory (fallback) → built-in recurring schedule (always-on).
                  Set <code style={{ color: CLR.warning, fontSize: 11 }}>NEWS_BLACKOUT_MINUTES</code> in .env.local to change the window (default: 15).
                </div>
              </div>
            </div>

            {/* ── V8.0: PRE-SESSION PLANNER — full-width ── */}
            <div className={`${styles.card2} ${styles.configFull}`}>
              <div className={styles.card2Head}>
                <span suppressHydrationWarning>{t.preSession}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <select
                    value={preScanSession}
                    onChange={(e) => setPreScanSession(e.target.value)}
                    style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.7)", borderRadius: 5, padding: "4px 8px", fontSize: 12, cursor: "pointer" }}
                  >
                    <option value="LONDON">🇬🇧 London (09:00)</option>
                    <option value="NEWYORK">🇺🇸 New York (14:00)</option>
                    <option value="EVENING">🌙 Evening (20:00)</option>
                  </select>
                  <button
                    className={`${styles.btn} ${styles.btnAccent}`}
                    style={{ padding: "5px 14px", fontSize: 12 }}
                    onClick={runManualPreScan}
                    disabled={preScanning}
                    suppressHydrationWarning
                  >
                    {preScanning ? t.preScanning : t.runPreScan}
                  </button>
                  <button
                    className={`${styles.btn} ${styles.btnGhost}`}
                    style={{ padding: "5px 12px", fontSize: 12 }}
                    onClick={fetchPreSession}
                    suppressHydrationWarning
                  >
                    ↻
                  </button>
                </div>
              </div>

              <div className={styles.dimText} style={{ marginBottom: 12 }} suppressHydrationWarning>
                {t.preSessionSub}
              </div>

              {/* Next auto-triggers */}
              {preSessionData?.nextTriggers?.length > 0 && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
                  {preSessionData.nextTriggers.slice(0, 3).map((tr) => (
                    <div key={tr.sessionKey} className={styles.infoBox} style={{ flex: 1, minWidth: 160 }}>
                      <div className={styles.infoTitle} style={{ color: CLR.warning }}>
                        ⏰ {tr.sessionKey}
                      </div>
                      <div className={styles.infoText}>
                        Pre-scan: <strong>{tr.triggerAt}</strong><br />
                        Session:  <strong>{tr.sessionAt}</strong><br />
                        In: <strong>{tr.minutesAway} min</strong>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Per-session status rows */}
              {preSessionData?.sessionStatus && (
                <div className={styles.newsTable}>
                  <div className={styles.newsTableHead}>
                    <span>SESSION</span>
                    <span>PRE-SCAN AT</span>
                    <span>STARTS AT</span>
                    <span>STATUS</span>
                    <span>PAIRS</span>
                  </div>
                  {preSessionData.sessionStatus.map((sess) => (
                    <div key={sess.key} className={`${styles.newsTableRow} ${sess.preScanDone ? styles.newsRowPast : ""}`}>
                      <span className={styles.newsTime} style={{ fontWeight: 700, color: CLR.accent }}>{sess.key}</span>
                      <span className={styles.newsTime}>{sess.preScanTime} GMT+1</span>
                      <span className={styles.newsTime}>{sess.startTime}–{sess.endTime}</span>
                      <span className={styles.newsWindow} style={{ color: sess.preScanDone ? CLR.success : CLR.textSecondary }}>
                        {sess.preScanDone ? `✅ Done (${sess.triggerType})` : "⏳ Pending"}
                      </span>
                      <span className={styles.newsEvt} style={{ fontSize: 10 }}>
                        {sess.selectedPairs.length > 0
                          ? sess.selectedPairs.slice(0, 4).join(", ") + (sess.selectedPairs.length > 4 ? ` +${sess.selectedPairs.length - 4}` : "")
                          : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {!preSessionData && (
                <div className={styles.dimText} suppressHydrationWarning>{t.noPreScan}</div>
              )}
            </div>

            {/* ── V8.0: BACKEND HEALTH MONITOR ── */}
            <div className={`${styles.card2} ${styles.configFull}`}>
              <div className={styles.card2Head}>
                <span suppressHydrationWarning>{t.backendHealth}</span>
                <button
                  className={`${styles.btn} ${styles.btnGhost}`}
                  style={{ padding: "4px 12px", fontSize: 12 }}
                  onClick={fetchHealthStatus}
                  suppressHydrationWarning
                >
                  ↻
                </button>
              </div>

              {healthStatus ? (
                <>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                    {[
                      { label: t.backendOnline,    value: healthStatus.backendOnline ? "✅ Yes" : "❌ No",  color: healthStatus.backendOnline ? CLR.success : CLR.error },
                      { label: t.lastCheck,         value: healthStatus.lastCheckAt ? new Date(healthStatus.lastCheckAt).toLocaleTimeString("en-US",{hour12:false}) : "—", color: CLR.accent },
                      { label: t.consecutiveFails,  value: healthStatus.consecutiveFails ?? 0, color: (healthStatus.consecutiveFails ?? 0) > 0 ? CLR.error : CLR.success },
                      { label: "Checks total",      value: healthStatus.checkCount ?? 0,    color: CLR.textSecondary },
                    ].map((s) => (
                      <div key={s.label} className={styles.statCard} style={{ flex: 1, minWidth: 120 }}>
                        <div className={styles.statCardAccent} style={{ background: s.color }} />
                        <div className={styles.statLabel} suppressHydrationWarning>{s.label}</div>
                        <div className={styles.statValue} style={{ color: s.color, fontSize: 15 }}>{String(s.value)}</div>
                      </div>
                    ))}
                  </div>
                  {!healthStatus.backendOnline && (
                    <div className={styles.newsCalBanner} style={{ borderColor: "rgba(209,52,56,0.4)", background: "rgba(209,52,56,0.08)" }}>
                      ⚠️ <strong>Backend is offline.</strong> Signal generation suspended. Telegram alert already sent.
                      Run: <code style={{ color: CLR.warning }}>pm2 restart signalex-backend</code>
                    </div>
                  )}
                  <div className={styles.infoBox} style={{ marginTop: 12 }}>
                    <div className={styles.infoTitle} style={{ color: CLR.accent }}>MONITORING BEHAVIOUR</div>
                    <div className={styles.infoText} suppressHydrationWarning>{t.monitorNote}</div>
                  </div>
                </>
              ) : (
                <div className={styles.dimText} suppressHydrationWarning>Loading health status…</div>
              )}
            </div>
          </div>
        )}

        {/* ════ TELEGRAM ════ */}
        {tab === 5 && (
          <div className={styles.twoCol}>
            <div className={styles.card2}>
              <div className={styles.card2Head}><span suppressHydrationWarning>{t.tgStatus}</span></div>
              {tgStatus && (
                <div className={`${styles.chip} ${tgStatus.ok ? styles.chipSuccess : styles.chipError}`} style={{ marginBottom: 14 }}>
                  {tgStatus.ok ? `✅ ${tgStatus.msg}` : `❌ ${tgStatus.msg}${tgStatus.hint ? ` — ${tgStatus.hint}` : ""}`}
                </div>
              )}
              <div className={styles.infoBox}>
                <div className={styles.infoTitle} suppressHydrationWarning>{t.betaDispatch}</div>
                <div className={styles.infoText} suppressHydrationWarning>{t.betaDispatchTxt}</div>
              </div>
            </div>
            <div className={styles.card2}>
              <div className={styles.card2Head}><span suppressHydrationWarning>{t.msgPreview}</span></div>
              {tgPreview ? (
                <pre className={styles.preBox}>{tgPreview}</pre>
              ) : (
                <div className={styles.emptyState} style={{ border: "none", padding: "20px 0" }}>
                  <div className={styles.emptyIcon}>✈️</div>
                  <div className={styles.dimText} suppressHydrationWarning>{t.runFirst}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ════ GUIDE ════ */}
        {tab === 6 && (
          <div className={styles.twoCol}>
            <div className={styles.card2}>
              <div className={styles.card2Head}><span suppressHydrationWarning>{t.quickStart}</span></div>
              {t.guideSteps.map(([n, title, desc]) => (
                <div key={n} className={styles.guideStep}>
                  <div className={styles.stepBadge}>{n}</div>
                  <div>
                    <div className={styles.stepTitle}>{title}</div>
                    <div className={styles.stepDesc}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className={styles.card2}>
              <div className={styles.card2Head}><span suppressHydrationWarning>{t.betaWorkflow}</span></div>
              {t.guideWorkflow.map(([name, desc]) => (
                <div key={name} className={styles.workRow}>
                  <div className={styles.workName}>{name}</div>
                  <div className={styles.workDesc}>{desc}</div>
                </div>
              ))}
              <div className={styles.infoBox} style={{ marginTop: 16, borderColor: "rgba(209,52,56,0.3)", background: "rgba(209,52,56,0.06)" }}>
                <div className={styles.infoTitle} style={{ color: CLR.error }} suppressHydrationWarning>{t.riskDisclaimer}</div>
                <div className={styles.infoText} suppressHydrationWarning>{t.riskText}</div>
              </div>
            </div>
          </div>
        )}

        {/* Settings Drawer */}
        <SettingsDrawer
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          currentSettings={controlState?.settings}
          onSettingsSaved={(updatedSettings) => {
            setControlState((prev) => ({
              ...prev,
              settings: updatedSettings,
            }));
          }}
        />

      </div>
    </div>
  );
}

// ─── SessionStats ──────────────────────────────────────────────────────────────
function SessionStats({ controller, t }) {
  const log = controller?.sessionLog;
  if (!log) return <div className={styles.dimText} style={{ padding: "20px 0" }} suppressHydrationWarning>{t.noHistory}</div>;
  const wr = log.winRate ? `${log.winRate}%` : "—";
  const wrColor = !log.winRate ? CLR.textDisabled
    : parseFloat(log.winRate) >= 55 ? CLR.success
    : parseFloat(log.winRate) >= 45 ? CLR.warning
    : CLR.error;
  return (
    <div>
      <div className={styles.statsRow} style={{ gridTemplateColumns: "repeat(4,1fr)", margin: "0 0 16px" }}>
        {[
          { label: t.total,   value: log.total,   color: CLR.accent   },
          { label: t.wins,    value: log.wins,    color: CLR.success  },
          { label: t.losses,  value: log.losses,  color: CLR.error    },
          { label: t.winRate, value: wr,           color: wrColor      },
        ].map((s) => (
          <div key={s.label} className={styles.statCard}>
            <div className={styles.statCardAccent} style={{ background: s.color }} />
            <div className={styles.statLabel} suppressHydrationWarning>{s.label}</div>
            <div className={styles.statValue} style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>
      {(log.consecutiveLosses > 0) && (
        <div className={styles.kvRow} style={{ marginBottom: 8 }}>
          <span className={styles.kvKey} style={{ color: CLR.error }} suppressHydrationWarning>{t.consecutiveLoss}</span>
          <span className={styles.kvVal} style={{ color: CLR.error, fontWeight: 700 }}>{log.consecutiveLosses}</span>
        </div>
      )}
      {log.trades?.length > 0 && (
        <>
          <div className={styles.miniHead} style={{ marginBottom: 8 }} suppressHydrationWarning>{t.recentTrades}</div>
          {log.trades.slice(0, 15).map((tr, i) => (
            <div key={i} className={styles.kvRow} style={{ gap: 10, alignItems: "center" }}>
              <span className={styles.kvKey}>{tr.pair}</span>
              <span style={{ color: tr.direction === "BUY" ? CLR.success : CLR.error, fontWeight: 600, fontSize: 12 }}>{tr.direction}</span>
              <span style={{ color: tr.result === "win" ? CLR.success : CLR.error, fontWeight: 700, fontSize: 13 }}>{(tr.result || "—").toUpperCase()}</span>
              <span className={styles.kvVal}>{tr.confidence}%</span>
              <span className={styles.kvVal} style={{ marginLeft: "auto" }}>{new Date(tr.at).toLocaleTimeString()}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ─── HistoryCard ───────────────────────────────────────────────────────────────
function HistoryCard({ session }) {
  const [open, setOpen] = useState(false);
  const total = session.total || 0;
  const wr = session.winRate ? `${session.winRate}%` : (total > 0 ? `${((session.wins / total) * 100).toFixed(1)}%` : "—");
  const wrColor = !total ? CLR.textDisabled
    : parseFloat(wr) >= 55 ? CLR.success
    : parseFloat(wr) >= 45 ? CLR.warning
    : CLR.error;
  const date = new Date(session.startedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = new Date(session.startedAt).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  return (
    <div className={styles.histRow}>
      <div className={styles.histHead} onClick={() => setOpen(!open)}>
        <span className={styles.kvKey}>{date} {time}</span>
        <span style={{ color: CLR.accent,   fontSize: 11 }}>T:{session.total}</span>
        <span style={{ color: CLR.success,  fontSize: 11 }}>W:{session.wins}</span>
        <span style={{ color: CLR.error,    fontSize: 11 }}>L:{session.losses}</span>
        <span style={{ color: wrColor, fontWeight: 700, fontSize: 12, marginLeft: "auto" }}>{wr}</span>
        <span style={{ color: CLR.textDisabled, fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && session.trades?.length > 0 && (
        <div className={styles.histTrades}>
          {session.trades.slice(0, 20).map((tr, i) => (
            <div key={i} className={styles.kvRow} style={{ gap: 8, fontSize: 11, alignItems: "center" }}>
              <span className={styles.kvKey}>{tr.pair}</span>
              <span style={{ color: tr.direction === "BUY" ? CLR.success : CLR.error }}>{tr.direction}</span>
              <span style={{ color: tr.result === "win" ? CLR.success : CLR.error, fontWeight: 700 }}>{(tr.result || "—").toUpperCase()}</span>
              <span style={{ color: CLR.textDisabled, marginLeft: "auto" }}>{new Date(tr.at).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SignalCard ────────────────────────────────────────────────────────────────
function SignalCard({ signal, rank, delay, t, isPrimary, onManualExecute }) {
  const isBuy    = signal.direction === "BUY";
  const dirColor = isBuy ? CLR.success : CLR.error;
  return (
    <div
      className={`${styles.sigCard} ${isBuy ? styles.sigCardBuy : styles.sigCardSell} ${isPrimary ? styles.sigCardPrimary : styles.sigCardContext}`}
      style={{ animationDelay: `${delay}ms`, opacity: isPrimary ? 1 : 0.78 }}
    >
      {/* PRIMARY badge — only signal #1 goes to Telegram */}
      {isPrimary && (
        <div className={styles.primaryBadge} style={{
          background: "linear-gradient(90deg, #107c10 0%, #0078d4 100%)",
          color: "#fff", fontWeight: 800, fontSize: 11, letterSpacing: 1.5,
          padding: "5px 12px", borderRadius: 6, marginBottom: 10,
          display: "flex", alignItems: "center", gap: 6,
          boxShadow: "0 0 12px rgba(0,120,212,0.35)",
        }}>
          <span>✈️</span>
          <span>#1 — PRIMARY SIGNAL — SEND TO TELEGRAM</span>
        </div>
      )}
      {/* CONTEXT badge — signals #2 and #3 are for awareness only */}
      {!isPrimary && rank === 2 && (
        <div className={styles.contextBadge} style={{
          background: "rgba(255,170,68,0.15)", color: CLR.warning,
          border: `1px solid ${CLR.warning}`, fontWeight: 700, fontSize: 10,
          letterSpacing: 1.2, padding: "4px 10px", borderRadius: 6, marginBottom: 10,
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <span>📊</span>
          <span>#2 — CONTEXT ONLY — DO NOT TRADE</span>
        </div>
      )}
      {!isPrimary && rank === 3 && (
        <div className={styles.contextBadge} style={{
          background: "rgba(255,255,255,0.05)", color: CLR.textSecondary,
          border: "1px solid rgba(255,255,255,0.12)", fontWeight: 700, fontSize: 10,
          letterSpacing: 1.2, padding: "4px 10px", borderRadius: 6, marginBottom: 10,
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <span>📉</span>
          <span>#3 — CONTEXT ONLY — DO NOT TRADE</span>
        </div>
      )}
      {/* P5: Manual execute button for SECONDARY signals */}
      {!isPrimary && signal.id && onManualExecute && (
        <div style={{ marginBottom: 10, display: "flex", gap: 6 }}>
          <button
            onClick={() => onManualExecute(signal.id, "execute")}
            style={{
              flex: 1, padding: "5px 8px", borderRadius: 5, border: "1px solid rgba(255,170,68,0.5)",
              background: "rgba(255,170,68,0.12)", color: CLR.warning, fontSize: 10,
              fontWeight: 700, cursor: "pointer", letterSpacing: 0.8,
            }}
          >
            ▶ EXECUTE MANUALLY
          </button>
          <button
            onClick={() => onManualExecute(signal.id, "result", "WIN")}
            style={{
              padding: "5px 8px", borderRadius: 5, border: "1px solid rgba(39,174,96,0.5)",
              background: "rgba(39,174,96,0.12)", color: CLR.success, fontSize: 10,
              fontWeight: 700, cursor: "pointer",
            }}
          >✅ WIN</button>
          <button
            onClick={() => onManualExecute(signal.id, "result", "LOSS")}
            style={{
              padding: "5px 8px", borderRadius: 5, border: "1px solid rgba(231,76,60,0.5)",
              background: "rgba(231,76,60,0.12)", color: CLR.error, fontSize: 10,
              fontWeight: 700, cursor: "pointer",
            }}
          >❌ LOSS</button>
        </div>
      )}
      {/* Card header */}
      <div className={styles.sigHead}>
        <span className={styles.sigRank} style={{
          background: isPrimary ? CLR.accent : "rgba(255,255,255,0.08)",
          color: isPrimary ? "#fff" : CLR.textSecondary,
          borderRadius: 4, padding: "2px 7px", fontWeight: 800, fontSize: 12,
        }}>#{rank}</span>
        <span className={styles.sigPair}>{signal.pair}</span>
        <span className={styles.sigDir} style={{ color: dirColor, borderColor: dirColor, background: isBuy ? CLR.successBg : CLR.errorBg }}>
          {isBuy ? "▲ BUY" : "▼ SELL"}
        </span>
      </div>

      {/* Confidence bar */}
      <div className={styles.confBar}>
        <div
          className={styles.confFill}
          style={{
            width: `${signal.confidence}%`,
            background: signal.confidence >= 70 ? CLR.success : signal.confidence >= 55 ? CLR.warning : CLR.error,
          }}
        />
      </div>
      <div className={styles.confLabel}>
        <span suppressHydrationWarning>{t.confidence}</span>
        <span style={{ color: signal.confidence >= 70 ? CLR.success : signal.confidence >= 55 ? CLR.warning : CLR.error, fontWeight: 700 }}>
          {signal.confidence}%
        </span>
      </div>

      {/* Data rows */}
      <div className={styles.sigBody}>
        {[
          [t.timeframe,   signal.timeframe,                                CLR.accent],
          [t.expiry,      signal.expiry,                                   CLR.warning],
          signal.entryWindow ? [t.entryWindow, signal.entryWindow,         CLR.success] : null,
          signal.marketPhase ? [t.marketPhase, signal.marketPhase,
            signal.marketPhase === "TRENDING" ? CLR.accent : signal.marketPhase === "RANGING" ? CLR.warning : CLR.error] : null,
          signal.signalTier  ? [t.tier, `Tier ${signal.signalTier}`,
            signal.signalTier === "A" ? CLR.success : signal.signalTier === "B" ? CLR.warning : CLR.textSecondary] : null,
          signal.marketQualityScore !== undefined ? [t.quality, `${signal.marketQualityScore}/100`,
            signal.marketQualityScore >= 70 ? CLR.success : signal.marketQualityScore >= 52 ? CLR.warning : CLR.error] : null,
          [t.strength, signal.strength,
            signal.strength === "STRONG" ? CLR.success : signal.strength === "MODERATE" ? CLR.warning : CLR.textSecondary],
        ].filter(Boolean).map(([label, value, color]) => (
          <div key={label} className={styles.sigRow}>
            <span className={styles.sigLabel} suppressHydrationWarning>{label}</span>
            <span className={styles.sigVal} style={{ color }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Analysis reasons */}
      {signal.reasons && (
        <div className={styles.sigReasons}>
          {Object.values(signal.reasons).filter(Boolean).map((r, i) => (
            <div key={i} className={styles.sigReason}>✅ {r}</div>
          ))}
        </div>
      )}
      {signal.warnings?.length > 0 && (
        <div className={styles.sigWarnings}>
          {signal.warnings.map((w, i) => (
            <div key={i} className={styles.sigWarning}>⚠️ {w}</div>
          ))}
        </div>
      )}

      {/* V7.0.3: Pocket Option clock-time entry instruction */}
      {signal.poInstruction && (
        <div className={styles.poBox}>
          <div className={styles.poLabel} suppressHydrationWarning>{t.poInstruction}</div>
          <div className={styles.poInstr}>{signal.poInstruction}</div>
        </div>
      )}

      <div className={styles.sigFoot} suppressHydrationWarning>{t.enterNextCandle}</div>
    </div>
  );
}
