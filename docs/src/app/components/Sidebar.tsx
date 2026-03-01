"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sections = [
  {
    label: "Guide",
    links: [
      { href: "/docs/getting-started", label: "Getting started" },
      { href: "/docs/dashboard", label: "Dashboard" },
    ],
  },
  {
    label: "API Reference",
    links: [
      { href: "/docs/signals", label: "Signals" },
      { href: "/docs/broadcasts", label: "Broadcasts" },
      { href: "/docs/adapters", label: "Adapters" },
      { href: "/docs/station", label: "Station Kit" },
    ],
  },
  {
    label: "Examples",
    links: [
      { href: "/docs/examples", label: "Overview" },
      { href: "/docs/examples/basic", label: "Basic" },
      { href: "/docs/examples/with-output", label: "With Output" },
      { href: "/docs/examples/with-steps", label: "With Steps" },
      { href: "/docs/examples/recurring", label: "Recurring" },
      { href: "/docs/examples/with-retries", label: "With Retries" },
      { href: "/docs/examples/with-sqlite", label: "With SQLite" },
      { href: "/docs/examples/broadcast", label: "Broadcast" },
      { href: "/docs/examples/etl-pipeline", label: "ETL Pipeline" },
      { href: "/docs/examples/ci-pipeline", label: "CI Pipeline" },
      { href: "/docs/examples/fleet-monitor", label: "Fleet Monitor" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="docs-sidebar">
      {sections.map((section) => (
        <div key={section.label} className="docs-sidebar-section">
          <div className="docs-sidebar-label">{section.label}</div>
          {section.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`docs-sidebar-link${pathname === link.href || (link.href !== "/docs/examples" && pathname.startsWith(link.href)) ? " active" : ""}`}
            >
              {link.label}
            </Link>
          ))}
        </div>
      ))}
    </aside>
  );
}
