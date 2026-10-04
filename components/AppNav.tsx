"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Role } from "@/lib/useUserRole";

const TABS = [
  { href: "/", label: "Přehled revizí" },
  { href: "/nahrat", label: "Import a kontrola" },
  { href: "/cenik", label: "Ceník" },
  { href: "/administrace", label: "Administrace", adminOnly: true },
];

export function AppNav({ role }: { role?: Role }) {
  const pathname = usePathname();
  const tabs = TABS.filter((tab) => !tab.adminOnly || role === "admin");

  return (
    <nav className="flex gap-1 border-b border-gray-200 bg-white px-7">
      {tabs.map((tab) => {
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
    </nav>
  );
}
