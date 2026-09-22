"use client";

import { createContext, useContext, useEffect } from "react";

export interface BreadcrumbSegment {
  label: string;
  href?: string;
}

export interface BreadcrumbContextValue {
  segments: BreadcrumbSegment[];
  activeSection: string | null;
  setSegments: (segments: BreadcrumbSegment[]) => void;
  setActiveSection: (section: string | null) => void;
}

export const BreadcrumbContext = createContext<BreadcrumbContextValue>({
  segments: [],
  activeSection: null,
  setSegments: () => {},
  setActiveSection: () => {},
});

export function useBreadcrumb(
  segments: BreadcrumbSegment[],
  section: string,
) {
  const ctx = useContext(BreadcrumbContext);
  useEffect(() => {
    ctx.setSegments(segments);
    ctx.setActiveSection(section);
  }, [JSON.stringify(segments), section]);
}

export function useBreadcrumbContext() {
  return useContext(BreadcrumbContext);
}
