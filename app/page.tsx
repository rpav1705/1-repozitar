"use client";

import { useEffect, useState } from "react";
import {
  collection,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";
import { RevizniZpravaModal } from "@/components/RevizniZpravaModal";
import { db } from "@/lib/firebase";

const PLAN_COLLECTION = "planovane_revize";
// Zobrazujeme všechny záznamy (aktuálně ~3032) – limit necháváme jen jako
// bezpečnostní strop, ať jedno načtení nikdy neroztáhne dotaz do nekonečna.
const TABLE_LIMIT = 5000;
const WARN_DAYS = 14;
const MISSING_TERMIN_STAV = "chybi_termin";

type PlanRow = {
  id: string;
  cislo_zarizeni: string;
  popis: string;
  /** null = při importu se nepodařilo rozpoznat termín (stav "chybi_termin"). */
  termin: Date | null;
  stav: string;
  /** null = zatím žádná revizní zpráva; jinak výsledek poslední spárované revize. */
  posledniRevizeVcas: boolean | null;
  /** URL PDF poslední spárované revizní zprávy ve Firebase Storage, nebo null. */
  posledniRevizniZpravaUrl: string | null;
  /** ID záznamu v kolekci "revizni_zpravy" – pro dotažení detailu do modálního okna. */
  posledniRevizniZpravaId: string | null;
};

type RowStatus = "overdue" | "warn" | "planned" | "missing";

// Řádek buď hoří (po termínu), blíží se, je jen naplánovaný do budoucna, nebo
// mu chybí termín a čeká na doplnění. Jestli byla POSLEDNÍ revize splněna
// včas, je nezávislá historická informace (posledniRevizeVcas) z revizní
// zprávy, ne aktuální stav řádku.
const STATUS_META: Record<RowStatus, { label: string; border: string; text: string }> = {
  overdue: { label: "Po termínu", border: "border-status-overdue", text: "text-status-overdue" },
  warn: { label: "Blíží se", border: "border-status-warn", text: "text-status-warn" },
  planned: { label: "Naplánováno", border: "border-status-planned", text: "text-status-planned" },
  missing: { label: "Nutno doplnit", border: "border-status-missing", text: "text-status-missing" },
};

function computeStatus(termin: Date | null, startOfToday: Date, warnUntil: Date): RowStatus {
  if (!termin) return "missing";
  if (termin < startOfToday) return "overdue";
  if (termin <= warnUntil) return "warn";
  return "planned";
}

// Filtr tabulky "Přehled zařízení" ovládaný kliknutím na statistické karty
// (a na tlačítko "Nutno doplnit data") – "all" = žádný filtr, výchozí stav.
type ActiveFilter = "all" | "warn" | "overdue" | "missing" | "vcas";

const FILTER_LABELS: Record<ActiveFilter, string> = {
  all: "Všechny záznamy",
  warn: "Blíží se termín",
  overdue: "Po termínu",
  missing: "Nutno doplnit data",
  vcas: "Splněno včas",
};

// Case-insensitive a na diakritice nezávislé porovnání pro fulltextové hledání.
function normalizeSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Krátký popis aktivního filtru (kategorie karty + text hledání) pro banner a prázdný stav. */
function describeActiveFilter(filter: ActiveFilter, search: string): string | null {
  const parts: string[] = [];
  if (filter !== "all") parts.push(FILTER_LABELS[filter]);
  if (search) parts.push(`hledání „${search}“`);
  return parts.length > 0 ? parts.join(" + ") : null;
}

type DashboardStats = {
  total: number;
  warn: number;
  overdue: number;
  missingTermin: number;
  /** Kolik záznamů má poslední revizi spárovanou a splněnou včas / se zpožděním. */
  vcasCount: number;
  pozdeCount: number;
};

type DashboardData = {
  stats: DashboardStats;
  rows: PlanRow[];
};

function useDashboardData() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const warnUntil = new Date(startOfToday);
        warnUntil.setDate(warnUntil.getDate() + WARN_DAYS);

        const col = collection(db, PLAN_COLLECTION);
        const startOfTodayTs = Timestamp.fromDate(startOfToday);
        const warnUntilTs = Timestamp.fromDate(warnUntil);

        const [totalSnap, overdueSnap, warnSnap, missingSnap, vcasSnap, pozdeSnap, tableSnap] =
          await Promise.all([
            getCountFromServer(col),
            getCountFromServer(query(col, where("termin", "<", startOfTodayTs))),
            getCountFromServer(
              query(col, where("termin", ">=", startOfTodayTs), where("termin", "<=", warnUntilTs))
            ),
            getCountFromServer(query(col, where("stav", "==", MISSING_TERMIN_STAV))),
            getCountFromServer(query(col, where("posledni_revize_vcas", "==", true))),
            getCountFromServer(query(col, where("posledni_revize_vcas", "==", false))),
            // Firestore řadí null před ostatními hodnotami, takže záznamy bez
            // termínu (stav "chybi_termin") vyjdou v tomto seřazení první.
            getDocs(query(col, orderBy("termin", "asc"), limit(TABLE_LIMIT))),
          ]);

        if (cancelled) return;

        const rows: PlanRow[] = tableSnap.docs.map((d) => {
          const record = d.data();
          return {
            id: d.id,
            cislo_zarizeni: typeof record.cislo_zarizeni === "string" ? record.cislo_zarizeni : "",
            popis: typeof record.popis === "string" ? record.popis : "",
            termin: record.termin instanceof Timestamp ? record.termin.toDate() : null,
            stav: typeof record.stav === "string" ? record.stav : "",
            posledniRevizeVcas:
              typeof record.posledni_revize_vcas === "boolean" ? record.posledni_revize_vcas : null,
            posledniRevizniZpravaUrl:
              typeof record.posledni_revizni_zprava_url === "string"
                ? record.posledni_revizni_zprava_url
                : null,
            posledniRevizniZpravaId:
              typeof record.posledni_revizni_zprava_id === "string"
                ? record.posledni_revizni_zprava_id
                : null,
          };
        });

        setData({
          stats: {
            total: totalSnap.data().count,
            overdue: overdueSnap.data().count,
            warn: warnSnap.data().count,
            missingTermin: missingSnap.data().count,
            vcasCount: vcasSnap.data().count,
            pozdeCount: pozdeSnap.data().count,
          },
          rows,
        });
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Nepodařilo se načíst data z databáze. Zkus to prosím znovu."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, error, loading };
}

function DashboardOverview() {
  const { data, error, loading } = useDashboardData();
  const [filter, setFilter] = useState<ActiveFilter>("all");
  const [searchText, setSearchText] = useState("");
  const [openZprava, setOpenZprava] = useState<{ id: string; pdfUrl: string } | null>(null);
  const trimmedSearch = searchText.trim();
  const searchNeedle = trimmedSearch ? normalizeSearchText(trimmedSearch) : "";
  const activeDescription = describeActiveFilter(filter, trimmedSearch);

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const warnUntil = new Date(startOfToday);
  warnUntil.setDate(warnUntil.getDate() + WARN_DAYS);

  const vcasCount = data?.stats.vcasCount ?? 0;
  const vcasEvaluated = data ? data.stats.vcasCount + data.stats.pozdeCount : 0;
  const vcasPercent = vcasEvaluated > 0 ? Math.round((vcasCount / vcasEvaluated) * 100) : 0;

  const stats: {
    label: string;
    value: string;
    note: string;
    color: string;
    filterValue: ActiveFilter | null;
  }[] = [
    {
      label: "Aktivní revize",
      value: data ? String(data.stats.total) : "—",
      note: "naplánováno · probíhá",
      color: "border-blue-600 text-blue-600",
      filterValue: "all",
    },
    {
      label: "Blíží se termín",
      value: data ? String(data.stats.warn) : "—",
      note: "do 14 dnů",
      color: "border-accent text-accent",
      filterValue: "warn",
    },
    {
      label: "Po termínu",
      value: data ? String(data.stats.overdue) : "—",
      note: data && data.stats.overdue > 0 ? "vyžaduje pozornost" : "žádné záznamy",
      color: "border-status-overdue text-status-overdue",
      filterValue: "overdue",
    },
    {
      label: "Splněno včas",
      value: vcasEvaluated > 0 ? `${vcasPercent}%` : "—",
      note: vcasEvaluated > 0 ? `${vcasCount}/${vcasEvaluated} revizí` : "zatím žádná data",
      color: "border-status-ok text-status-ok",
      filterValue: vcasEvaluated > 0 ? "vcas" : null,
    },
  ];

  return (
    <>
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-600">{error}</p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => {
          const clickable = s.filterValue !== null;
          const isActive = clickable && s.filterValue === filter;
          return (
            <button
              key={s.label}
              type="button"
              disabled={!clickable}
              onClick={() => s.filterValue && setFilter(s.filterValue)}
              title={clickable ? `Zobrazit jen: ${s.label}` : "Zatím bez dat"}
              className={`rounded-lg border-l-4 bg-white px-[18px] py-4 text-left shadow-sm transition-shadow ${s.color.split(" ")[0]} ${
                clickable ? "cursor-pointer hover:shadow-md" : "cursor-default opacity-90"
              } ${isActive ? "ring-2 ring-navy ring-offset-1" : ""}`}
            >
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                {s.label}
              </div>
              <div className={`mt-1.5 text-[28px] font-bold ${s.color.split(" ")[1]}`}>
                {s.value}
              </div>
              <div className="mt-0.5 text-[11px] text-gray-400">{s.note}</div>
            </button>
          );
        })}
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
        {data && data.stats.missingTermin > 0 && (
          <button
            onClick={() => setFilter("missing")}
            title="Záznamy z importu, u kterých se nepodařilo rozpoznat termín – je potřeba je ručně doplnit."
            className={`rounded-md border px-5 py-2.5 text-[13px] font-semibold tracking-wide transition-colors ${
              filter === "missing"
                ? "border-status-missing bg-status-missing text-white"
                : "border-status-missing bg-white text-status-missing hover:bg-gray-50"
            }`}
          >
            Nutno doplnit data ({data.stats.missingTermin})
          </button>
        )}

        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Hledat podle čísla zařízení nebo popisu…"
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-[13px] outline-none focus:border-accent focus:ring-1 focus:ring-accent sm:ml-auto sm:w-72"
        />
      </div>

      {(() => {
        const visibleRows = data
          ? data.rows
              .filter((row) => {
                if (filter === "all") return true;
                if (filter === "vcas") return row.posledniRevizeVcas === true;
                return computeStatus(row.termin, startOfToday, warnUntil) === filter;
              })
              .filter(
                (row) =>
                  !searchNeedle ||
                  normalizeSearchText(row.cislo_zarizeni).includes(searchNeedle) ||
                  normalizeSearchText(row.popis).includes(searchNeedle)
              )
          : [];

        return (
          <div className="overflow-hidden rounded-lg bg-white shadow-sm">
            <div className="flex items-center justify-between bg-navy px-[18px] py-2.5 text-[13px] font-bold text-white">
              <span>Přehled zařízení</span>
              <span className="text-[12px] font-normal text-white/60">
                {data ? `${visibleRows.length} záznamů` : loading ? "Načítám…" : "0 záznamů"}
              </span>
            </div>

            {data && activeDescription && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-[18px] py-2 text-[12px] text-gray-600">
                <span>
                  Zobrazeno: <span className="font-semibold">{activeDescription}</span> (
                  {visibleRows.length} záznamů)
                </span>
                <button
                  onClick={() => {
                    setFilter("all");
                    setSearchText("");
                  }}
                  className="font-semibold text-navy underline-offset-2 hover:underline"
                >
                  Zobrazit vše
                </button>
              </div>
            )}

            {loading && (
              <div className="px-[18px] py-10 text-center text-[13px] text-gray-400">
                Načítám přehled revizí…
              </div>
            )}

            {!loading && data && visibleRows.length === 0 && (
              <div className="px-[18px] py-10 text-center text-[13px] text-gray-400">
                {activeDescription
                  ? `Žádné záznamy pro: ${activeDescription}.`
                  : "Zatím žádná zařízení. Nahraj plán revizí (.xls) v záložce „Nahrát dokumenty“, ať se tu objeví přehled."}
              </div>
            )}

            {!loading && data && visibleRows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500">
                      <th className="py-2 pl-[18px] pr-4 font-semibold">Číslo zařízení</th>
                      <th className="py-2 pr-4 font-semibold">Popis</th>
                      <th className="py-2 pr-4 font-semibold">Revize platná do:</th>
                      <th className="py-2 pr-[18px] font-semibold">Stav</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => {
                      const status = computeStatus(row.termin, startOfToday, warnUntil);
                      const meta = STATUS_META[status];
                      return (
                        <tr
                          key={row.id}
                          className={`border-l-4 border-b border-gray-100 ${meta.border}`}
                        >
                          <td className="py-2 pl-[14px] pr-4">{row.cislo_zarizeni}</td>
                          <td className="py-2 pr-4">{row.popis}</td>
                          <td className="py-2 pr-4">
                            {row.termin ? (
                              row.termin.toLocaleDateString("cs-CZ")
                            ) : (
                              <span className="text-status-missing">chybí termín</span>
                            )}
                          </td>
                          <td className={`py-2 pr-[18px] font-semibold ${meta.text}`}>
                            {meta.label}
                            {row.posledniRevizniZpravaUrl && row.posledniRevizniZpravaId && (
                              <button
                                type="button"
                                onClick={() =>
                                  setOpenZprava({
                                    id: row.posledniRevizniZpravaId as string,
                                    pdfUrl: row.posledniRevizniZpravaUrl as string,
                                  })
                                }
                                title="Zobrazit detail revizní zprávy"
                                className="ml-2 inline-flex items-center gap-1 rounded-full border border-status-ok px-2 py-0.5 align-middle text-[10px] font-semibold text-status-ok hover:bg-green-50"
                              >
                                <svg
                                  width="11"
                                  height="11"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                  <path d="M14 2v6h6" />
                                </svg>
                                Revizní zpráva
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {data.stats.total > data.rows.length && (
                  <p className="px-[18px] py-2 text-[11px] text-gray-400">
                    Načteno prvních {data.rows.length} z {data.stats.total} záznamů celkem (limit
                    dotazu) – filtry a řazení pracují jen s touto načtenou částí.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {openZprava && (
        <RevizniZpravaModal
          zpravaId={openZprava.id}
          pdfUrl={openZprava.pdfUrl}
          onClose={() => setOpenZprava(null)}
        />
      )}
    </>
  );
}

export default function Home() {
  return (
    <AuthGate>
      {(user) => (
        <div className="flex min-h-full flex-1 flex-col bg-[#eef1f5]">
          <AppHeader user={user} />
          <AppNav />

          <div className="flex flex-col gap-4 px-7 py-6">
            <div className="rounded-md border border-blue-100 bg-blue-50 px-4 py-2.5 text-[12.5px] text-blue-700">
              Vítej, {user.email}!
            </div>

            <DashboardOverview />
          </div>
        </div>
      )}
    </AuthGate>
  );
}
