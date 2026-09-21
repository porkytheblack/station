"use client";

import Link from "next/link";

export function ExecutionNavigation({ label, base, current, items }: {
  label: string; base: string; current: string; items: string[];
}) {
  return <nav className="execution-navigation" aria-label={label}>
    {items.map(item => <Link key={item} href={`${base}/${item}`} aria-current={current === item ? "page" : undefined}>
      {item.charAt(0).toUpperCase() + item.slice(1)}
    </Link>)}
  </nav>;
}
