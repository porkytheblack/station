"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useCallback, useEffect } from "react";
import { ThemeToggle } from "./ThemeToggle";
import { sections } from "./sidebar-data";

const navLinks = [
  { href: "/docs/getting-started", label: "Docs" },
  { href: "/docs/signals", label: "API" },
  { href: "/docs/examples", label: "Examples" },
];

export function Nav() {
  const pathname = usePathname();
  const isDocs = pathname.startsWith("/docs");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  const toggleMenu = useCallback(() => {
    setMobileMenuOpen((prev) => !prev);
  }, []);

  return (
    <>
      <nav className="site-nav">
        <Link href="/" className="site-nav-brand">
          <span className="pulse-dot" />
          Station
        </Link>
        <ul className="site-nav-links">
          {navLinks.map((link) => {
            const isActive =
              link.label === "Docs" && isDocs
                ? true
                : link.label === "Examples"
                  ? pathname.startsWith("/docs/examples")
                  : pathname === link.href;

            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={isActive ? "active" : ""}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
          <li>
            <a
              href="https://github.com/porkytheblack/station"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </li>
        </ul>
        <div className="site-nav-right">
          <ThemeToggle />
          <button
            className="mobile-menu-toggle"
            onClick={toggleMenu}
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileMenuOpen}
          >
            <span className={`hamburger-icon${mobileMenuOpen ? " open" : ""}`}>
              <span />
              <span />
              <span />
            </span>
          </button>
        </div>
      </nav>

      <div
        className={`mobile-drawer-backdrop${mobileMenuOpen ? " open" : ""}`}
        onClick={() => setMobileMenuOpen(false)}
      />
      <aside
        className={`mobile-drawer${mobileMenuOpen ? " open" : ""}`}
        aria-hidden={!mobileMenuOpen}
      >
        <div className="mobile-drawer-links">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="mobile-drawer-nav-link"
              onClick={() => setMobileMenuOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <a
            href="https://github.com/porkytheblack/station"
            target="_blank"
            rel="noopener noreferrer"
            className="mobile-drawer-nav-link"
          >
            GitHub
          </a>
        </div>
        {isDocs && (
          <div className="mobile-drawer-sidebar">
            {sections.map((section) => (
              <div key={section.label} className="docs-sidebar-section">
                <div className="docs-sidebar-label">{section.label}</div>
                {section.links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`docs-sidebar-link${
                      pathname === link.href ||
                      (link.href !== "/docs/examples" &&
                        pathname.startsWith(link.href))
                        ? " active"
                        : ""
                    }`}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            ))}
          </div>
        )}
      </aside>
    </>
  );
}
