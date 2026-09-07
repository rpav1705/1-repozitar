"use client";

import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";

export default function Home() {
  return (
    <AuthGate>
      {(user) => {
        const stats = [
          { label: "Aktivní revize", value: "0", note: "naplánováno · probíhá", color: "border-blue-600 text-blue-600" },
          { label: "Blíží se termín", value: "0", note: "do 14 dnů", color: "border-accent text-accent" },
          { label: "Po termínu", value: "0", note: "žádné záznamy", color: "border-status-overdue text-status-overdue" },
          { label: "Splněno včas", value: "—", note: "zatím žádná data", color: "border-status-ok text-status-ok" },
        ];

        return (
          <div className="flex min-h-full flex-1 flex-col bg-[#eef1f5]">
            <AppHeader user={user} />
            <AppNav />

            <div className="flex flex-col gap-4 px-7 py-6">
              <div className="rounded-md border border-blue-100 bg-blue-50 px-4 py-2.5 text-[12.5px] text-blue-700">
                Vítej, {user.email}! Zatím tu nemáš žádné revize – jakmile nahrajeme plán a servisní
                protokoly, objeví se přehled tady.
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {stats.map((s) => (
                  <div
                    key={s.label}
                    className={`rounded-lg border-l-4 bg-white px-[18px] py-4 shadow-sm ${s.color.split(" ")[0]}`}
                  >
                    <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                      {s.label}
                    </div>
                    <div className={`mt-1.5 text-[28px] font-bold ${s.color.split(" ")[1]}`}>
                      {s.value}
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-400">{s.note}</div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-3">
                <a
                  href="/nahrat"
                  className="rounded-md bg-accent px-5 py-2.5 text-[13px] font-bold tracking-wide text-white transition-colors hover:bg-orange-600"
                >
                  + NAHRÁT REVIZI
                </a>
                <button
                  disabled
                  className="cursor-not-allowed rounded-md border border-gray-300 bg-white px-5 py-2.5 text-[13px] font-semibold text-navy opacity-60"
                  title="Připravujeme"
                >
                  Správa zařízení
                </button>
              </div>

              <div className="overflow-hidden rounded-lg bg-white shadow-sm">
                <div className="flex items-center justify-between bg-navy px-[18px] py-2.5 text-[13px] font-bold text-white">
                  <span>Přehled zařízení</span>
                  <span className="text-[12px] font-normal text-white/60">0 záznamů</span>
                </div>
                <div className="px-[18px] py-10 text-center text-[13px] text-gray-400">
                  Zatím žádná zařízení. Jakmile přidáme nahrávání .xls plánu a PDF protokolů, zobrazí se
                  zde přehled revizí.
                </div>
              </div>
            </div>
          </div>
        );
      }}
    </AuthGate>
  );
}
