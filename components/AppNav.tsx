"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Přehled revizí" },
  { href: "/nahrat", label: "Nahrát dokumenty" },
];

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 border-b border-gray-200 bg-white px-7">
      {TABS.map((tab) => {
        const isActive = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-4 py-3 text-[13px] font-semibold ${
              isActive
                ? "border-b-[3px] border-accent text-navy"
                : "border-b-[3px] border-transparent text-gray-500 hover:text-navy"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
      <div className="cursor-default px-4 py-3 text-[13px] font-semibold text-gray-400">
        Administrace
      </div>
    </nav>
  );
}
