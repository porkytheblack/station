"use client";

import { useEffect, useState } from "react";

function format(date: string): string {
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RelativeTime({ date }: { date: string }) {
  const [text, setText] = useState(() => format(date));

  useEffect(() => {
    const interval = setInterval(() => {
      setText(format(date));
    }, 5000);
    return () => clearInterval(interval);
  }, [date]);

  return (
    <span className="mono" title={new Date(date).toLocaleString()} style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>
      {text}
    </span>
  );
}
