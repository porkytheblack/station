"use client";

import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from "react";
import { useRealtime, type StationEvent } from "./use-realtime";

interface StationState {
  connected: boolean;
  events: StationEvent[];
}

const StationContext = createContext<StationState>({
  connected: false,
  events: [],
});

export function useStation() {
  return useContext(StationContext);
}

export function StationProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<StationEvent[]>([]);

  const handleEvent = useCallback((event: StationEvent) => {
    setEvents((prev) => [event, ...prev].slice(0, 100));
  }, []);

  const { connected } = useRealtime(handleEvent);

  return (
    <StationContext.Provider value={{ connected, events }}>
      {children}
    </StationContext.Provider>
  );
}
