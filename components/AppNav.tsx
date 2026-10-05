"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Role } from "@/lib/useUserRole";
import { useTypRevize } from "@/lib/TypRevizeContext";
import { TYPY_REVIZE } from "@/lib/typRevize";

const TABS = [
  { href: "/", label: "Přehled revizí" },
  { href: "/nahrat", label: "Import a kontrola" },
  { href: "/cenik", label: "Ceník" },
  { href: "/administrace", label: "Administrace", adminOnly: true },
];

// Administrace se druhu revizí netýká (správa uživatelů), přepínač tam proto
// appka neukazuje, ať nevzbuzuje dojem, že volba na ni má vliv.
const BEZ_PREPINACE = new Set(["/administrace"]);

export function AppNav({ role }: { role?: Role }) {
  const pathname = usePathname();
  const { typ, setTyp } = useTypRevize();
  const tabs = TABS.filter((tab) => !tab.adminOnly || role === "admin");

  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-gray-200 bg-white px-7">
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

      {!BEZ_PREPINACE.has(pathname) && (
        <div className="ml-auto flex items-center gap-2 py-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Druh revizí
          </span>
          <div className="inline-flex overflow-hidden rounded-md border border-gray-300 text-[12.5px] font-semibold">
            {TYPY_REVIZE.map((k, i) => (
              <button
                key={k.typ}
                type="button"
                onClick={() => setTyp(k.typ)}
                aria-pressed={typ === k.typ}
                className={`px-3 py-1.5 transition-colors ${i > 0 ? "border-l border-gray-300" : ""} ${
                  typ === k.typ
                    ? "bg-navy text-white"
                    : "bg-white text-gray-600 hover:bg-gray-100"
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}
