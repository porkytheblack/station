"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sections = [
  {
    label: "Guide",
    links: [
      { href: "/docs/getting-started", label: "Getting started" },
    ],
  },
  {
    label: "API Reference",
    links: [
      { href: "/docs/signals", label: "Signals" },
      { href: "/docs/broadcasts", label: "Broadcasts" },
      { href: "/docs/adapters", label: "Adapters" },
      { href: "/docs/station", label: "Station" },
    ],
  },
  {
    label: "Showcase",
    links: [
      { href: "/docs/examples", label: "Examples" },
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
              className={`docs-sidebar-link${pathname === link.href ? " active" : ""}`}
            >
              {link.label}
            </Link>
          ))}
        </div>
      ))}
    </aside>
  );
}
