"use client";

import { useEffect, useRef, useCallback, useState } from "react";

const WS_BASE = process.env.NEXT_PUBLIC_STATION_API ?? "http://localhost:4400";

export interface StationEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export function useRealtime(onEvent: (event: StationEvent) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closed = false;

    function connect() {
      if (closed) return;

      const wsUrl = WS_BASE.replace(/^http/, "ws") + "/api/events";
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setConnected(true);
        attempt = 0;
      };

      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as StationEvent;
          onEventRef.current(event);
        } catch (err) {
          console.error("Failed to parse WebSocket message:", err);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          attempt++;
          reconnectTimer = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { connected };
}
