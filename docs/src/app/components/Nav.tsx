"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

const navLinks = [
  { href: "/docs/getting-started", label: "Docs" },
  { href: "/docs/signals", label: "API" },
  { href: "/docs/examples", label: "Examples" },
];

export function Nav() {
  const pathname = usePathname();
  const isDocs = pathname.startsWith("/docs");

  return (
    <nav className="site-nav">
      <Link href="/" className="site-nav-brand">
        <span className="pulse-dot" />
        Signal
      </Link>
      <ul className="site-nav-links">
        {navLinks.map((link) => {
          const isActive =
            link.label === "Docs" && isDocs
              ? true
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
            href="https://github.com/dterminal/simple-signal"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
        </li>
      </ul>
      <ThemeToggle />
    </nav>
  );
}
