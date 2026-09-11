"use client";

import { useEffect, useState } from "react";
import {
  collection,
  DocumentData,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  QueryDocumentSnapshot,
  Timestamp,
  where,
} from "firebase/firestore";
import { RevizniZpravyImportZdroj } from "@/lib/importLog";
import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";
import { db } from "@/lib/firebase";
import { VysledekRevize } from "@/lib/pdfRevizniZprava";

const PLAN_COLLECTION = "planovane_revize";
// Zobrazujeme všechny záznamy (aktuálně ~3032) – limit necháváme jen jako
// bezpečnostní strop, ať jedno načtení nikdy neroztáhne dotaz do nekonečna.
const TABLE_LIMIT = 5000;
const WARN_DAYS = 30;
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
  /** Datum provedení poslední spárované revize, nebo null. */
  datumProvedeni: Date | null;
  /** Jméno technika, který poslední revizi provedl, nebo null. */
  technikJmeno: string | null;
  /** Evidenční číslo oprávnění technika, nebo null. */
  technikCisloOpravneni: string | null;
  /** URL PDF PŘEDCHOZÍ (druhé nejnovější) revizní zprávy, nebo null, pokud žádná není. */
  predchoziRevizniZpravaUrl: string | null;
  /** Datum provedení předchozí revizní zprávy, nebo null. */
  predchoziDatumProvedeni: Date | null;
  /** Klasifikace "Celkové hodnocení" poslední revizní zprávy, nebo null (žádná zpráva/starší data bez backfillu). */
  vysledekRevize: VysledekRevize | null;
  /** Text zjištěné závady z poslední revizní zprávy, nebo null. */
  zjistenaZavada: string | null;
};

const VYSLEDEK_REVIZE_META: Record<VysledekRevize, { label: string; className: string }> = {
  OK: { label: "OK", className: "border-status-ok text-status-ok bg-green-50" },
  NOK: { label: "NOK", className: "border-status-overdue text-status-overdue bg-red-50" },
  KE_KONTROLE: { label: "Ke kontrole", className: "border-status-warn text-status-warn bg-orange-50" },
};

/**
 * Badge s výsledkem revize + (u NOK/Ke kontrole) zjištěnou závadou – zkrácenou
 * na jeden řádek s "…", ať sloupec nerozbíjí šířku tabulky. Najetí myší
 * ukáže celý text (title), kliknutí ho rozbalí/sbalí přímo v buňce (pro
 * dotykové ovládání, kde title nefunguje).
 */
function VysledekReviseBadge({
  vysledek,
  zavada,
}: {
  vysledek: VysledekRevize | null;
  zavada: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!vysledek) return <span className="text-gray-300">—</span>;

  const meta = VYSLEDEK_REVIZE_META[vysledek];
  const zobrazitZavadu = vysledek !== "OK" && zavada;

  return (
    <div className="flex flex-col items-start gap-1">
      <span
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.className}`}
      >
        {meta.label}
      </span>
      {zobrazitZavadu && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          title={zavada}
          className={`text-left text-[11px] text-gray-500 hover:text-gray-700 ${
            expanded ? "whitespace-normal" : "max-w-[220px] truncate"
          }`}
        >
          {zavada}
        </button>
      )}
    </div>
  );
}

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
// (a na tlačítka "Nutno doplnit data" / "Bez" / "S platnou revizní zprávou")
// – "all" = žádný filtr, výchozí stav. Všechny hodnoty se vzájemně vylučují,
// protože je drží jediný stav "filter" – "bez_zpravy" a "s_zpravou" tak
// fungují jako přepínač stejně jako ostatní.
type ActiveFilter =
  | "all"
  | "warn"
  | "overdue"
  | "missing"
  | "bez_zpravy"
  | "s_zpravou"
  | "vysledek_ok"
  | "vysledek_nok"
  | "vysledek_ke_kontrole";

const FILTER_LABELS: Record<ActiveFilter, string> = {
  all: "Všechny záznamy",
  warn: "Blíží se termín",
  overdue: "Po termínu",
  missing: "Nutno doplnit data",
  bez_zpravy: "Bez platné revizní zprávy",
  s_zpravou: "S platnou revizní zprávou",
  vysledek_ok: "Výsledek revize: OK",
  vysledek_nok: "Výsledek revize: NOK",
  vysledek_ke_kontrole: "Výsledek revize: Ke kontrole",
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

        const [totalSnap, overdueSnap, warnSnap, missingSnap, tableSnap] =
          await Promise.all([
            getCountFromServer(col),
            getCountFromServer(query(col, where("termin", "<", startOfTodayTs))),
            getCountFromServer(
              query(col, where("termin", ">=", startOfTodayTs), where("termin", "<=", warnUntilTs))
            ),
            getCountFromServer(query(col, where("stav", "==", MISSING_TERMIN_STAV))),
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
            datumProvedeni: record.datum_provedeni instanceof Timestamp ? record.datum_provedeni.toDate() : null,
            technikJmeno: typeof record.technik_jmeno === "string" ? record.technik_jmeno : null,
            technikCisloOpravneni:
              typeof record.technik_cislo_opravneni === "string" ? record.technik_cislo_opravneni : null,
            predchoziRevizniZpravaUrl:
              typeof record.predchozi_revizni_zprava_url === "string"
                ? record.predchozi_revizni_zprava_url
                : null,
            predchoziDatumProvedeni:
              record.predchozi_datum_provedeni instanceof Timestamp
                ? record.predchozi_datum_provedeni.toDate()
                : null,
            vysledekRevize:
              record.vysledek_revize === "OK" ||
              record.vysledek_revize === "NOK" ||
              record.vysledek_revize === "KE_KONTROLE"
                ? record.vysledek_revize
                : null,
            zjistenaZavada: typeof record.zjistena_zavada === "string" ? record.zjistena_zavada : null,
          };
        });

        setData({
          stats: {
            total: totalSnap.data().count,
            overdue: overdueSnap.data().count,
            warn: warnSnap.data().count,
            missingTermin: missingSnap.data().count,
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

const IMPORT_LOG_COLLECTION = "import_log";
// Kolik čísel zařízení appka u rozkliknuté karty ukáže najednou – log
// záznam jich (viz lib/importLog.ts) může mít uložené až tisíc, ale
// vypisovat všechny by u velkých dávek zbytečně zatížilo vykreslení.
const LOG_ITEMS_DISPLAY_LIMIT = 60;

const REVIZE_ZDROJ_LABELS: Record<RevizniZpravyImportZdroj, string> = {
  nahrani: "přímé nahrání PDF",
  zpracovat_ulozene_nove: "Zpracovat uložené (jen nové)",
  zpracovat_ulozene_vse: "Zpracovat znovu úplně vše",
};

type PlanImportLog = {
  cas: Date;
  pridanoCelkem: number;
  aktualizovanoCelkem: number;
  smazanoCelkem: number;
  pridano: string[];
  aktualizovano: string[];
  smazano: string[];
};

type RevizniZpravyImportLog = {
  cas: Date;
  zdroj: RevizniZpravyImportZdroj;
  zpracovanoCelkem: number;
  chybaCelkem: number;
  zarizeni: string[];
};

type ImportLogsData = {
  plan: PlanImportLog | null;
  revize: RevizniZpravyImportLog | null;
  /** Poslední datum nahrání zprávy zjištěné přímo z "revizni_zpravy" – použije
   *  se jako náhrada za chybějící log záznam u dat z doby PŘED zavedením
   *  "import_log" (viz bod 4 zadání), ať karta místo chyby/prázdna ukáže
   *  aspoň tohle. */
  revizeFallbackCas: Date | null;
};

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Záznam s nejnovějším polem "cas" z pole snapshotů (dotaz do "import_log"
 *  cíleně nepoužívá orderBy – kombinace where("typ", "==", …) + orderBy by
 *  vyžadovala vytvořit složený index ve Firestore konzoli. Kolekce s logy
 *  roste jen o jeden záznam na import/zpracování, takže seřazení na klientovi
 *  z celé (malé) načtené sady je bez problému.). */
function nejnovejsiLogDoc(
  docs: QueryDocumentSnapshot<DocumentData>[]
): QueryDocumentSnapshot<DocumentData> | null {
  let nejnovejsi: QueryDocumentSnapshot<DocumentData> | null = null;
  let nejnovejsiMs = -Infinity;
  for (const d of docs) {
    const cas = d.data().cas;
    const ms = cas instanceof Timestamp ? cas.toMillis() : -Infinity;
    if (ms > nejnovejsiMs) {
      nejnovejsi = d;
      nejnovejsiMs = ms;
    }
  }
  return nejnovejsi;
}

function useImportLogs() {
  const [data, setData] = useState<ImportLogsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const logCol = collection(db, IMPORT_LOG_COLLECTION);
        const [planSnap, revizeSnap] = await Promise.all([
          getDocs(query(logCol, where("typ", "==", "plan"))),
          getDocs(query(logCol, where("typ", "==", "revizni_zpravy"))),
        ]);
        if (cancelled) return;

        const planDoc = nejnovejsiLogDoc(planSnap.docs);
        const plan: PlanImportLog | null = (() => {
          if (!planDoc) return null;
          const record = planDoc.data();
          const cas = record.cas instanceof Timestamp ? record.cas.toDate() : null;
          if (!cas) return null;
          const pocty = (record.pocty ?? {}) as Record<string, unknown>;
          const polozky = (record.polozky ?? {}) as Record<string, unknown>;
          return {
            cas,
            pridanoCelkem: typeof pocty.pridano === "number" ? pocty.pridano : 0,
            aktualizovanoCelkem: typeof pocty.aktualizovano === "number" ? pocty.aktualizovano : 0,
            smazanoCelkem: typeof pocty.smazano === "number" ? pocty.smazano : 0,
            pridano: toStringArray(polozky.pridano),
            aktualizovano: toStringArray(polozky.aktualizovano),
            smazano: toStringArray(polozky.smazano),
          };
        })();

        const revizeDoc = nejnovejsiLogDoc(revizeSnap.docs);
        const revize: RevizniZpravyImportLog | null = (() => {
          if (!revizeDoc) return null;
          const record = revizeDoc.data();
          const cas = record.cas instanceof Timestamp ? record.cas.toDate() : null;
          if (!cas) return null;
          const pocty = (record.pocty ?? {}) as Record<string, unknown>;
          const polozky = (record.polozky ?? {}) as Record<string, unknown>;
          const zdroj: RevizniZpravyImportZdroj =
            record.zdroj === "zpracovat_ulozene_nove" || record.zdroj === "zpracovat_ulozene_vse"
              ? record.zdroj
              : "nahrani";
          return {
            cas,
            zdroj,
            zpracovanoCelkem: typeof pocty.zpracovano === "number" ? pocty.zpracovano : 0,
            chybaCelkem: typeof pocty.chyba === "number" ? pocty.chyba : 0,
            zarizeni: toStringArray(polozky.zarizeni),
          };
        })();

        let revizeFallbackCas: Date | null = null;
        if (!revize) {
          // Stará data z doby PŘED zavedením "import_log" – appka aspoň ukáže
          // datum nahrání nejnovější uložené revizní zprávy, ať karta místo
          // "chyba" zobrazí nejlepší dostupnou náhradu (viz bod 4 zadání).
          const fallbackSnap = await getDocs(
            query(collection(db, "revizni_zpravy"), orderBy("nahrano", "desc"), limit(1))
          );
          if (cancelled) return;
          const nahrano = fallbackSnap.docs[0]?.data().nahrano;
          revizeFallbackCas = nahrano instanceof Timestamp ? nahrano.toDate() : null;
        }

        setData({ plan, revize, revizeFallbackCas });
      } catch {
        if (!cancelled) setData({ plan: null, revize: null, revizeFallbackCas: null });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading };
}

function formatLogCas(d: Date): string {
  return d.toLocaleString("cs-CZ", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Informativní karta o posledním importu/zpracování – rozklikáváním (ne
 * modálem/tooltipem, appka jinde v UI drží detail vždy inline) ukáže seznam
 * dotčených čísel zařízení z detailGroups.
 */
function ImportLogCard({
  title,
  cas,
  summary,
  detailGroups,
}: {
  title: string;
  cas: Date | null;
  summary: string;
  detailGroups: { label: string; items: string[] }[];
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = detailGroups.some((g) => g.items.length > 0);

  return (
    <div className="rounded-lg border-l-4 border-blue-600 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((e) => !e)}
        disabled={!hasDetail}
        title={hasDetail ? "Zobrazit/skrýt seznam dotčených zařízení" : undefined}
        className={`flex w-full items-start justify-between gap-3 px-[18px] py-4 text-left ${
          hasDetail ? "cursor-pointer hover:bg-gray-50" : "cursor-default"
        }`}
      >
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{title}</div>
          <div className="mt-1.5 text-[17px] font-bold text-navy">
            {cas ? formatLogCas(cas) : "Zatím žádný záznam"}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-400">{summary}</div>
        </div>
        {hasDetail && (
          <span
            className={`mt-1 shrink-0 text-[10px] text-gray-400 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          >
            ▼
          </span>
        )}
      </button>

      {expanded && hasDetail && (
        <div className="border-t border-gray-100 px-[18px] py-3 text-[12px] text-gray-600">
          {detailGroups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <div key={g.label} className="mb-2.5 last:mb-0">
                <div className="font-semibold text-gray-500">
                  {g.label} ({g.items.length})
                </div>
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {g.items.slice(0, LOG_ITEMS_DISPLAY_LIMIT).map((item, i) => (
                    <li key={i} className="rounded bg-gray-100 px-1.5 py-0.5">
                      {item || "(bez čísla)"}
                    </li>
                  ))}
                </ul>
                {g.items.length > LOG_ITEMS_DISPLAY_LIMIT && (
                  <p className="mt-1 text-[10.5px] text-gray-400">
                    Zobrazeno prvních {LOG_ITEMS_DISPLAY_LIMIT} z {g.items.length}.
                  </p>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function DashboardOverview() {
  const { data, error, loading } = useDashboardData();
  const { data: importLogs, loading: importLogsLoading } = useImportLogs();
  const [filter, setFilter] = useState<ActiveFilter>("all");
  const [searchText, setSearchText] = useState("");
  const trimmedSearch = searchText.trim();
  const searchNeedle = trimmedSearch ? normalizeSearchText(trimmedSearch) : "";
  const activeDescription = describeActiveFilter(filter, trimmedSearch);

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const warnUntil = new Date(startOfToday);
  warnUntil.setDate(warnUntil.getDate() + WARN_DAYS);

  // Počítáno z už načtených řádků (ne zvlášť dotazem) – pole
  // posledniRevizniZpravaUrl na nich už je, takže netřeba další dotaz do
  // Firestore navíc.
  const pocetSPlatnouZpravou = data
    ? data.rows.filter((row) => row.posledniRevizniZpravaUrl !== null).length
    : 0;
  const pocetBezPlatneZpravy = data ? data.rows.length - pocetSPlatnouZpravou : 0;

  // Stejně jako u ostatních karet počítáno z už načtených řádků – vysledekRevize
  // je null u zařízení bez PDF nebo u starších dat bez zpětného doplnění, taková
  // se do žádné z těchto tří karet nezapočítávají (OK+NOK+KE_KONTROLE <= počet řádků).
  const pocetVysledekOk = data
    ? data.rows.filter((row) => row.vysledekRevize === "OK").length
    : 0;
  const pocetVysledekNok = data
    ? data.rows.filter((row) => row.vysledekRevize === "NOK").length
    : 0;
  const pocetVysledekKeKontrole = data
    ? data.rows.filter((row) => row.vysledekRevize === "KE_KONTROLE").length
    : 0;

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
      note: `do ${WARN_DAYS} dnů`,
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
  ];

  return (
    <>
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-600">{error}</p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ImportLogCard
          title="Poslední import plánu (.xls)"
          cas={importLogs?.plan?.cas ?? null}
          summary={
            importLogsLoading
              ? "Načítám…"
              : importLogs?.plan
                ? `${importLogs.plan.pridanoCelkem} nových, ${importLogs.plan.aktualizovanoCelkem} aktualizovaných, ${importLogs.plan.smazanoCelkem} smazaných (INACTIVE)`
                : "Zatím žádný záznam importu"
          }
          detailGroups={[
            { label: "Nově přidáno", items: importLogs?.plan?.pridano ?? [] },
            { label: "Aktualizováno", items: importLogs?.plan?.aktualizovano ?? [] },
            { label: "Smazáno (INACTIVE)", items: importLogs?.plan?.smazano ?? [] },
          ]}
        />
        <ImportLogCard
          title="Poslední zpracování revizních zpráv (PDF)"
          cas={importLogs?.revize?.cas ?? importLogs?.revizeFallbackCas ?? null}
          summary={
            importLogsLoading
              ? "Načítám…"
              : importLogs?.revize
                ? `${importLogs.revize.zpracovanoCelkem} zpracováno${
                    importLogs.revize.chybaCelkem > 0 ? `, ${importLogs.revize.chybaCelkem} selhalo` : ""
                  } (${REVIZE_ZDROJ_LABELS[importLogs.revize.zdroj]})`
                : importLogs?.revizeFallbackCas
                  ? "Zatím žádný záznam zpracování – datum poslední nahrané zprávy"
                  : "Zatím žádný záznam"
          }
          detailGroups={[{ label: "Dotčená čísla zařízení", items: importLogs?.revize?.zarizeni ?? [] }]}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <a
          href="/nahrat"
          className="rounded-md bg-accent px-5 py-2.5 text-[13px] font-bold tracking-wide text-white transition-colors hover:bg-orange-600"
        >
          + NAHRÁT REVIZI
        </a>
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

        {data && (
          <div className="inline-flex overflow-hidden rounded-md border border-gray-300 text-[12.5px] font-semibold">
            <button
              onClick={() => setFilter("bez_zpravy")}
              title="Zobrazit jen zařízení bez spárované aktuální revizní zprávy"
              className={`px-3 py-2 transition-colors ${
                filter === "bez_zpravy"
                  ? "bg-status-missing text-white"
                  : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              Bez platné revizní zprávy ({pocetBezPlatneZpravy})
            </button>
            <button
              onClick={() => setFilter("s_zpravou")}
              title="Zobrazit jen zařízení se spárovanou aktuální revizní zprávou"
              className={`border-l border-gray-300 px-3 py-2 transition-colors ${
                filter === "s_zpravou"
                  ? "bg-status-ok text-white"
                  : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              S platnou revizní zprávou ({pocetSPlatnouZpravou})
            </button>
          </div>
        )}

        {data && (
          <div className="flex items-center gap-2 border-l border-gray-300 pl-3">
            <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
              Výsledek revize
            </span>
            <div className="inline-flex overflow-hidden rounded-md border border-gray-300 text-[12.5px] font-semibold">
              <button
                onClick={() => setFilter("vysledek_ok")}
                title="Zobrazit jen zařízení s výsledkem revize OK"
                className={`px-3 py-2 transition-colors ${
                  filter === "vysledek_ok"
                    ? "bg-status-ok text-white"
                    : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                OK ({pocetVysledekOk})
              </button>
              <button
                onClick={() => setFilter("vysledek_nok")}
                title="Zobrazit jen zařízení s výsledkem revize NOK"
                className={`border-l border-gray-300 px-3 py-2 transition-colors ${
                  filter === "vysledek_nok"
                    ? "bg-status-overdue text-white"
                    : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                NOK ({pocetVysledekNok})
              </button>
              <button
                onClick={() => setFilter("vysledek_ke_kontrole")}
                title="Zobrazit jen zařízení s výsledkem revize Ke kontrole"
                className={`border-l border-gray-300 px-3 py-2 transition-colors ${
                  filter === "vysledek_ke_kontrole"
                    ? "bg-status-warn text-white"
                    : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                Ke kontrole ({pocetVysledekKeKontrole})
              </button>
            </div>
          </div>
        )}

        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Hledat podle čísla zařízení nebo popisu…"
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-[13px] outline-none focus:border-accent focus:ring-1 focus:ring-accent sm:w-64"
        />
      </div>

      {(() => {
        const visibleRows = data
          ? data.rows
              .filter((row) => {
                if (filter === "all") return true;
                if (filter === "bez_zpravy") return row.posledniRevizniZpravaUrl === null;
                if (filter === "s_zpravou") return row.posledniRevizniZpravaUrl !== null;
                if (filter === "vysledek_ok") return row.vysledekRevize === "OK";
                if (filter === "vysledek_nok") return row.vysledekRevize === "NOK";
                if (filter === "vysledek_ke_kontrole") return row.vysledekRevize === "KE_KONTROLE";
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
                      <th className="py-2 pr-4 font-semibold">Provedeno dne</th>
                      <th className="py-2 pr-4 font-semibold">Revizi provedl</th>
                      <th className="py-2 pr-4 font-semibold">Číslo oprávnění</th>
                      <th className="py-2 pr-4 font-semibold">Výsledek revize</th>
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
                              // timeZone: "UTC" – kalendářní datum bez času uložené přes Date.UTC()
                              // (viz lib/parseDate.ts), zobrazit ve stejné zóně, jinak by ho
                              // prohlížeč v jiné zóně mohl u půlnočních časů posunout o den.
                              row.termin.toLocaleDateString("cs-CZ", { timeZone: "UTC" })
                            ) : (
                              <span className="text-status-missing">chybí termín</span>
                            )}
                          </td>
                          <td className="py-2 pr-4">
                            {row.datumProvedeni ? row.datumProvedeni.toLocaleDateString("cs-CZ", { timeZone: "UTC" }) : "—"}
                          </td>
                          <td className="py-2 pr-4">{row.technikJmeno || "—"}</td>
                          <td className="py-2 pr-4">{row.technikCisloOpravneni || "—"}</td>
                          <td className="py-2 pr-4">
                            <VysledekReviseBadge vysledek={row.vysledekRevize} zavada={row.zjistenaZavada} />
                          </td>
                          <td className={`py-2 pr-[18px] font-semibold ${meta.text}`}>
                            {meta.label}
                            {row.posledniRevizniZpravaUrl && (
                              <a
                                href={row.posledniRevizniZpravaUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Otevřít revizní zprávu (PDF)"
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
                              </a>
                            )}
                            {row.predchoziRevizniZpravaUrl && (
                              <a
                                href={row.predchoziRevizniZpravaUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Otevřít předchozí revizní zprávu (PDF)${
                                  row.predchoziDatumProvedeni
                                    ? ` – provedeno ${row.predchoziDatumProvedeni.toLocaleDateString("cs-CZ", { timeZone: "UTC" })}`
                                    : ""
                                }`}
                                className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-gray-300 px-2 py-0.5 align-middle text-[10px] font-semibold text-gray-500 hover:bg-gray-100"
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
                                Předchozí revizní zpráva
                              </a>
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
