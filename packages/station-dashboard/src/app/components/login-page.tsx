"use client";

import { useState, type FormEvent } from "react";
import { login } from "../hooks/use-api";
import { useLoginCallback } from "./auth-provider";

export function LoginPage() {
  const onSuccess = useLoginCallback();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const ok = await login(username, password);
      if (ok) {
        onSuccess();
      } else {
        setError("Invalid credentials.");
      }
    } catch {
      setError("Connection failed.");
    }
    setLoading(false);
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <svg width="28" height="28" viewBox="0 0 100 100" fill="none" aria-hidden="true">
            <path d="M50 2 L39 25 L27 50 L18 70 L10 88 L90 88 L82 70 L73 50 L61 25 Z" stroke="currentColor" strokeWidth="1.5" />
            <line x1="50" y1="2" x2="50" y2="88" stroke="currentColor" strokeWidth="1" />
            <line x1="16" y1="70" x2="84" y2="70" stroke="currentColor" strokeWidth="1.2" />
            <line x1="39" y1="25" x2="61" y2="25" stroke="currentColor" strokeWidth="0.8" />
            <line x1="27" y1="50" x2="73" y2="50" stroke="currentColor" strokeWidth="0.8" />
            <rect x="43" y="88" width="14" height="5" fill="currentColor" opacity="0.5" />
            <circle cx="50" cy="2" r="1.5" fill="currentColor" />
          </svg>
          <h1>Station</h1>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div className="login-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="btn btn--primary login-btn" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
