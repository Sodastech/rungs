"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly count?: number;
}

export function NavLinks({ items }: { items: readonly NavItem[] }) {
  const path = usePathname();
  const current = items
    .filter((item) => path === item.href || path.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav className="nav" aria-label="Main">
      {items.map((item) => {
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.href === current ? "page" : undefined}
          >
            {item.label}
            {item.count !== undefined && item.count > 0 && (
              <span className="count">
                {item.count}
                <span className="visually-hidden"> waiting</span>
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
