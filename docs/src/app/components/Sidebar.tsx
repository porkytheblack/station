"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { sections } from "./sidebar-data";

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
