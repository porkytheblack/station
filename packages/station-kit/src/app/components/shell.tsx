"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStation } from "../hooks/use-station";
import { useBreadcrumbContext } from "../hooks/use-breadcrumb";
import { useTheme } from "./theme-provider";

function getInitialCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("station-sidebar") === "collapsed";
}

/* ── Sidebar Icons ─────────────────────────────────────────
   All icons use currentColor and a consistent 14x14 viewport
   so they inherit text color and align with monospace labels. */

function IconTower({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <path d="M50 2 L39 25 L27 50 L18 70 L10 88 L90 88 L82 70 L73 50 L61 25 Z" stroke="currentColor" strokeWidth="1.5" />
      <line x1="50" y1="2" x2="50" y2="88" stroke="currentColor" strokeWidth="1" />
      <line x1="16" y1="70" x2="84" y2="70" stroke="currentColor" strokeWidth="1.2" />
      <line x1="39" y1="25" x2="61" y2="25" stroke="currentColor" strokeWidth="0.8" />
      <line x1="27" y1="50" x2="73" y2="50" stroke="currentColor" strokeWidth="0.8" />
      <rect x="43" y="88" width="14" height="5" fill="currentColor" opacity="0.5" />
      <circle cx="50" cy="2" r="1.5" fill="currentColor" />
    </svg>
  );
}

function IconOverview() {
  /* 2x2 grid — universal dashboard icon */
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="1" y="1" width="5" height="5" rx="1" />
      <rect x="8" y="1" width="5" height="5" rx="1" />
      <rect x="1" y="8" width="5" height="5" rx="1" />
      <rect x="8" y="8" width="5" height="5" rx="1" />
    </svg>
  );
}

function IconSignals() {
  /* Signal arcs radiating from a point — antenna broadcast */
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="12" r="1" fill="currentColor" stroke="none" />
      <path d="M4.5 10a3.5 3.5 0 0 1 5 0" />
      <path d="M2.5 8a6 6 0 0 1 9 0" />
      <path d="M0.5 6a8.5 8.5 0 0 1 13 0" />
    </svg>
  );
}

function IconBroadcasts() {
  /* DAG: one root splitting to two children — workflow graph */
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <circle cx="7" cy="2.5" r="1.5" />
      <circle cx="3" cy="11.5" r="1.5" />
      <circle cx="11" cy="11.5" r="1.5" />
      <line x1="6.2" y1="3.8" x2="3.8" y2="10" />
      <line x1="7.8" y1="3.8" x2="10.2" y2="10" />
    </svg>
  );
}

function NavLink({
  href,
  label,
  section,
  icon,
}: {
  href: string;
  label: string;
  section: string;
  icon: React.ReactNode;
}) {
  const pathname = usePathname();
  const { activeSection } = useBreadcrumbContext();

  const isActive = activeSection
    ? activeSection === section
    : href === "/"
      ? pathname === "/"
      : pathname.startsWith(href);

  return (
    <Link href={href} className={isActive ? "active" : ""}>
      {icon}
      <span className="nav-label">{label}</span>
    </Link>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { connected } = useStation();
  const { segments } = useBreadcrumbContext();
  const { theme, toggle } = useTheme();
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);

  const toggleSidebar = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("station-sidebar", next ? "collapsed" : "expanded");
      return next;
    });
  }, []);

  return (
    <div className="station-layout" data-collapsed={collapsed}>
      <aside className="station-sidebar">
        <div className="station-sidebar-logo">
          <div className="station-sidebar-mark">
            <IconTower size={20} />
            <h1>Station</h1>
          </div>
          <span>station-signal</span>
        </div>
        <nav className="station-sidebar-nav">
          <div className="station-sidebar-nav-label">Nav</div>
          <NavLink href="/" label="Overview" section="overview" icon={<IconOverview />} />
          <NavLink href="/signals" label="Signals" section="signals" icon={<IconSignals />} />
          <NavLink href="/broadcasts" label="Broadcasts" section="broadcasts" icon={<IconBroadcasts />} />
        </nav>
        <button
          className="sidebar-collapse-btn"
          onClick={toggleSidebar}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            {collapsed ? (
              <polyline points="5 3 9 7 5 11" />
            ) : (
              <polyline points="9 3 5 7 9 11" />
            )}
          </svg>
        </button>
      </aside>
      <div className="station-main">
        <header className="station-header">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            {segments.length === 0 ? (
              <span className="breadcrumb-segment">overview</span>
            ) : (
              segments.map((seg, i) => (
                <span key={i} className="breadcrumb-item">
                  {i > 0 && <span className="breadcrumb-sep" aria-hidden="true">/</span>}
                  {seg.href ? (
                    <Link href={seg.href} className="breadcrumb-link">{seg.label}</Link>
                  ) : (
                    <span className="breadcrumb-segment breadcrumb-segment--current" aria-current="page">{seg.label}</span>
                  )}
                </span>
              ))
            )}
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <button
              onClick={toggle}
              className="theme-toggle"
              title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
              aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            >
              {theme === "light" ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M13.5 8.5a5.5 5.5 0 0 1-7-7A5.5 5.5 0 1 0 13.5 8.5Z" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="8" cy="8" r="3" />
                  <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
                </svg>
              )}
            </button>
            <div
              className={`pulse-dot ${connected ? "" : "pulse-dot--disconnected"}`}
              title={connected ? "Connected" : "Disconnected"}
            />
          </div>
        </header>
        <main className="station-content">{children}</main>
      </div>
    </div>
  );
}
