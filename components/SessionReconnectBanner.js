"use client";

import React, { useState, useEffect } from "react";
import styles from "./SessionReconnectBanner.module.css";

export default function SessionReconnectBanner({ gateway, onReconnected }) {
  const [sessionInput, setSessionInput] = useState("");
  const [uidInput, setUidInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [connectingStart, setConnectingStart] = useState(null);

  const isConnected = gateway?.connected === true;
  const sessionStatus = gateway?.session || "unknown";
  const isValid = isConnected && sessionStatus === "valid";

  // Grace period tracking for "connecting" state
  useEffect(() => {
    if (sessionStatus === "connecting") {
      if (!connectingStart) {
        setConnectingStart(Date.now());
      }
    } else {
      setConnectingStart(null);
    }
  }, [sessionStatus, connectingStart]);

  if (isValid) {
    return null;
  }

  // Grace period: do not show during the first 10 s of "connecting"
  if (sessionStatus === "connecting" && connectingStart && Date.now() - connectingStart < 10000) {
    return null;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!sessionInput.trim() || !uidInput.trim()) {
      setFeedback({ ok: false, text: "Please enter both Session token and UID." });
      return;
    }

    setLoading(true);
    setFeedback(null);

    const submittedSession = sessionInput.trim();
    const submittedUid = uidInput.trim();

    // Clear fields immediately
    setSessionInput("");
    setUidInput("");

    try {
      const res = await fetch("/api/po-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: submittedSession,
          uid: submittedUid,
        }),
      });

      const data = await res.json().catch(() => ({ ok: false }));

      if (res.ok && data.ok) {
        setFeedback({
          ok: true,
          text: "Session validated successfully! Pocket Option broker is connected.",
        });
        if (typeof onReconnected === "function") {
          onReconnected();
        }
      } else {
        const statusText = data?.status ? ` (status: ${data.status})` : "";
        setFeedback({
          ok: false,
          text: (data?.error || "Failed to authenticate with Pocket Option") + statusText,
        });
      }
    } catch (err) {
      setFeedback({
        ok: false,
        text: `Network error updating session: ${err.message}`,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.banner} role="alert">
      <div className={styles.bannerHeader}>
        <div className={styles.title}>
          <span>⚠️</span> Pocket Option Broker Session Required
        </div>
        <div className={styles.statusTag}>
          {sessionStatus}
        </div>
      </div>
      <div className={styles.description}>
        The automated broker session is currently not active ({sessionStatus}). Paste fresh credentials to re-authenticate without restarting the application:
      </div>
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.inputGroup}>
          <input
            type="password"
            autoComplete="off"
            className={styles.input}
            placeholder="Pocket Option session token"
            value={sessionInput}
            onChange={(e) => setSessionInput(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className={styles.inputGroup}>
          <input
            type="text"
            autoComplete="off"
            className={styles.input}
            placeholder="Pocket Option UID"
            value={uidInput}
            onChange={(e) => setUidInput(e.target.value)}
            disabled={loading}
          />
        </div>
        <button type="submit" className={styles.submitBtn} disabled={loading}>
          {loading ? "Reconnecting..." : "Update Credentials"}
        </button>
      </form>
      {feedback && (
        <div className={feedback.ok ? styles.feedbackSuccess : styles.feedbackError}>
          {feedback.text}
        </div>
      )}
    </div>
  );
}
