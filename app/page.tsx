"use client";

import { useEffect, useState } from "react";
import {
  collection,
  doc,
  DocumentData,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  QueryDocumentSnapshot,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import * as XLSX from "xlsx";
import { RevizniZpravyImportZdroj } from "@/lib/importLog";
import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";
import { db } from "@/lib/firebase";
import { formatCena } from "@/lib/formatCena";
import { formatLogCas } from "@/lib/formatLogCas";
import { VysledekRevize } from "@/lib/pdfRevizniZprava";
import { sanitizeDocId } from "@/lib/revizniZpravyFirestore";

const PLAN_COLLECTION = "planovane_revize";
const CENIK_COLLECTION = "cenik";
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
  /** Cena revize podle čísla zařízení z kolekce "cenik" (viz app/cenik/page.tsx), nebo null, pokud tam zařízení není. */
  cena: number | null;
  /**
   * Poznámka o ruční opravě NOK zprávy (viz VysledekReviseBadge) – appka
   * díky ní zjištěnou závadu opravenou "na papíře" i v appce dál nepočítá
   * jako otevřenou (efektivniVysledekRevize ji ukáže jako OK), ale pořád je
   * vidět, že šlo PŮVODNĚ o NOK a kdy/proč se to změnilo. Null = zpráva
   * nebyla (nebo už není, viz komentář u oprava_* v
   * lib/revizniZpravyHistorie.ts) takhle ručně opravená.
   */
  opravaPoznamka: string | null;
  opravaDatum: Date | null;
  opravaUzivatelEmail: string | null;
};

/**
 * Efektivní výsledek revize – NOK zpráva s poznámkou o ruční opravě (viz
 * PlanRow.opravaPoznamka) se pro statistiky/filtrování/karty počítá jako OK
 * (appka "zprávu mění na OK", jak appka od uživatele požaduje), samotný
 * badge (VysledekReviseBadge) ale pořád zobrazí, že šlo PŮVODNĚ o NOK a kdy
 * bylo opraveno – appka tak nikde tiše neschová, že k opravě došlo.
 */
function efektivniVysledekRevize(row: PlanRow): VysledekRevize | null {
  if (row.vysledekRevize === "NOK" && row.opravaPoznamka) return "OK";
  return row.vysledekRevize;
}

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
 *
 * U NOK zprávy appka navíc nabídne "+ Zaznamenat opravu" – po zapsání
 * poznámky (co bylo opraveno) appka zprávu ukazuje jako OK (viz
 * efektivniVysledekRevize), ale badge PŘESTO dál zobrazuje původní NOK
 * (jako druhý štítek "opraveno") i samotnou poznámku, takže je vidět, že ke
 * změně došlo ručně po opravě, ne že by zpráva byla od začátku v pořádku.
 */
function VysledekReviseBadge({
  row,
  onOznacitOpravene,
}: {
  row: PlanRow;
  onOznacitOpravene: (poznamka: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [formOteviren, setFormOteviren] = useState(false);
  const [poznamkaText, setPoznamkaText] = useState("");
  const [ukladam, setUkladam] = useState(false);
  const [chyba, setChyba] = useState("");

  const vysledek = row.vysledekRevize;
  if (!vysledek) return <span className="text-gray-300">—</span>;

  const jeOpravene = vysledek === "NOK" && !!row.opravaPoznamka;
  const zobrazenyVysledek = efektivniVysledekRevize(row) ?? vysledek;
  const meta = VYSLEDEK_REVIZE_META[zobrazenyVysledek];
  const zavada = row.zjistenaZavada;
  const zobrazitZavadu = vysledek !== "OK" && zavada;

  const handleUlozitOpravu = async () => {
    const trimmed = poznamkaText.trim();
    if (!trimmed) {
      setChyba("Napiš prosím poznámku o opravě.");
      return;
    }
    setUkladam(true);
    setChyba("");
    try {
      await onOznacitOpravene(trimmed);
      setFormOteviren(false);
      setPoznamkaText("");
    } catch (err) {
      setChyba(
        err instanceof Error ? err.message : "Nepodařilo se uložit opravu. Zkus to prosím znovu."
      );
    } finally {
      setUkladam(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.className}`}
        >
          {meta.label}
        </span>
        {jeOpravene && (
          <span
            className="inline-flex items-center rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700"
            title={
              row.opravaDatum
                ? `Původně NOK, opraveno ${row.opravaDatum.toLocaleDateString("cs-CZ", { timeZone: "UTC" })}${
                    row.opravaUzivatelEmail ? ` (${row.opravaUzivatelEmail})` : ""
                  }`
                : "Původně NOK, opraveno"
            }
          >
            opraveno
          </span>
        )}
      </div>

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

      {jeOpravene && (
        <p className="max-w-[220px] text-[11px] text-blue-700">
          Oprava: {row.opravaPoznamka}
          {row.opravaDatum && (
            <span className="text-blue-400">
              {" "}
              ({row.opravaDatum.toLocaleDateString("cs-CZ", { timeZone: "UTC" })})
            </span>
          )}
        </p>
      )}

      {vysledek === "NOK" && !jeOpravene && !formOteviren && (
        <button
          type="button"
          onClick={() => setFormOteviren(true)}
          className="text-[11px] font-semibold text-blue-600 hover:underline"
        >
          + Zaznamenat opravu
        </button>
      )}

      {formOteviren && (
        <div className="mt-1 flex w-56 flex-col gap-1.5 rounded-md border border-gray-200 bg-gray-50 p-2">
          <textarea
            value={poznamkaText}
            onChange={(e) => setPoznamkaText(e.target.value)}
            placeholder="Co bylo opraveno…"
            rows={2}
            autoFocus
            className="w-full resize-none rounded border border-gray-300 px-2 py-1 text-[11px] outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          {chyba && <p className="text-[10.5px] text-red-600">{chyba}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleUlozitOpravu}
              disabled={ukladam}
              className="rounded bg-status-ok px-2 py-1 text-[10.5px] font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ukladam ? "Ukládám…" : "Označit jako opravené (OK)"}
            </button>
            <button
              type="button"
              onClick={() => {
                setFormOteviren(false);
                setPoznamkaText("");
                setChyba("");
              }}
              disabled={ukladam}
              className="text-[10.5px] text-gray-500 hover:underline"
            >
              Zrušit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Buňka s cenou – u zařízení bez ceny (viz filtr "Bez ceny") appka místo "—"
 * nabídne rovnou v tabulce "+ Doplnit cenu", ať uživatel nemusí kvůli
 * jedné chybějící ceně chodit na stránku Ceník. Uložená cena jde stejnou
 * cestou i znovu upravit (tužka vedle částky).
 */
function CenaBunka({
  row,
  onUlozitCenu,
}: {
  row: PlanRow;
  onUlozitCenu: (cena: number) => Promise<void>;
}) {
  const [editace, setEditace] = useState(false);
  const [hodnota, setHodnota] = useState("");
  const [ukladam, setUkladam] = useState(false);
  const [chyba, setChyba] = useState("");

  const zahajitEditaci = () => {
    setHodnota(row.cena !== null ? String(row.cena) : "");
    setChyba("");
    setEditace(true);
  };

  const handleUlozit = async () => {
    const cena = Number(hodnota.replace(",", "."));
    if (!hodnota.trim() || Number.isNaN(cena) || cena < 0) {
      setChyba("Zadej platnou cenu.");
      return;
    }
    setUkladam(true);
    setChyba("");
    try {
      await onUlozitCenu(cena);
      setEditace(false);
    } catch (err) {
      setChyba(
        err instanceof Error ? err.message : "Nepodařilo se uložit cenu. Zkus to prosím znovu."
      );
    } finally {
      setUkladam(false);
    }
  };

  if (editace) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <input
            type="number"
            min="0"
            step="0.01"
            value={hodnota}
            onChange={(e) => setHodnota(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleUlozit();
              if (e.key === "Escape") setEditace(false);
            }}
            autoFocus
            className="w-20 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={handleUlozit}
            disabled={ukladam}
            className="text-[10.5px] font-semibold text-status-ok hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            {ukladam ? "Ukládám…" : "Uložit"}
          </button>
          <button
            type="button"
            onClick={() => setEditace(false)}
            disabled={ukladam}
            className="text-[10.5px] text-gray-500 hover:underline"
          >
            Zrušit
          </button>
        </div>
        {chyba && <p className="text-[10.5px] text-red-600">{chyba}</p>}
      </div>
    );
  }

  if (row.cena !== null) {
    return (
      <div className="flex items-center gap-1.5">
        <span>{formatCena(row.cena)}</span>
        <button
          type="button"
          onClick={zahajitEditaci}
          title="Upravit cenu"
          className="text-[10px] text-gray-300 hover:text-blue-600"
        >
          ✎
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={zahajitEditaci}
      className="text-[11px] font-semibold text-blue-600 hover:underline"
    >
      + Doplnit cenu
    </button>
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
  | "vysledek_ke_kontrole"
  | "nok_opraveno"
  | "bez_ceny"
  | "s_cenou";

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
  nok_opraveno: "NOK opraveno",
  bez_ceny: "Bez ceny",
  s_cenou: "S cenou",
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

/** Krátký, souborový (bez diakritiky/mezer/velkých písmen) tvar textu – pro název exportovaného souboru. */
function slugify(text: string): string {
  return normalizeSearchText(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Exportuje řádky do .xlsx souboru se stejnými sloupci, jaké appka ukazuje
 * v tabulce "Přehled zařízení". Appka exportuje přesně tu sadu řádků, kterou
 * jí zavolající předá (viz volání u tlačítka "Export do Excelu" –
 * visibleRows PO filtru i hledání), ne celou databázi znovu dotazem, ať
 * export vždycky odpovídá tomu, co uživatel na obrazovce právě vidí.
 */
function exportujDoExcelu(
  rows: PlanRow[],
  startOfToday: Date,
  warnUntil: Date,
  filter: ActiveFilter,
  search: string
) {
  const data = rows.map((row) => {
    const status = computeStatus(row.termin, startOfToday, warnUntil);
    return {
      "Číslo zařízení": row.cislo_zarizeni,
      Popis: row.popis,
      Cena: row.cena ?? "",
      "Revize platná do": row.termin
        ? row.termin.toLocaleDateString("cs-CZ", { timeZone: "UTC" })
        : "chybí termín",
      "Provedeno dne": row.datumProvedeni
        ? row.datumProvedeni.toLocaleDateString("cs-CZ", { timeZone: "UTC" })
        : "",
      "Revizi provedl": row.technikJmeno ?? "",
      "Číslo oprávnění": row.technikCisloOpravneni ?? "",
      // Záměrně PŮVODNÍ (ne efektivní) výsledek – export má sloužit i jako
      // podklad k dohledání historie, ne jen aktuální stav (ten appka i tak
      // dává najevo přes sloupce "Opraveno"/"Poznámka k opravě" níž).
      "Výsledek revize": row.vysledekRevize ? VYSLEDEK_REVIZE_META[row.vysledekRevize].label : "",
      "Zjištěná závada": row.zjistenaZavada ?? "",
      Opraveno: row.vysledekRevize === "NOK" && row.opravaPoznamka ? "Ano" : "",
      "Poznámka k opravě": row.opravaPoznamka ?? "",
      "Datum opravy": row.opravaDatum
        ? row.opravaDatum.toLocaleDateString("cs-CZ", { timeZone: "UTC" })
        : "",
      Stav: STATUS_META[status].label,
    };
  });

  const sheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Přehled");

  const nazevFiltru = filter === "all" ? "vsechny-zaznamy" : slugify(FILTER_LABELS[filter]);
  const nazevHledani = search ? `-hledani-${slugify(search)}` : "";
  const datum = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, `revize-${nazevFiltru}${nazevHledani}-${datum}.xlsx`);
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

        const [totalSnap, overdueSnap, warnSnap, missingSnap, tableSnap, cenikSnap] =
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
            // Ceny appka spáruje podle čísla zařízení (viz app/cenik/page.tsx) –
            // stejný přístup jako u výpočtu měsíčních nákladů tam.
            getDocs(collection(db, CENIK_COLLECTION)),
          ]);

        if (cancelled) return;

        const cenyPodleZarizeni = new Map<string, number>();
        cenikSnap.docs.forEach((d) => {
          const cenikData = d.data();
          const cislo = typeof cenikData.cislo_zarizeni === "string" ? cenikData.cislo_zarizeni : "";
          if (cislo && typeof cenikData.cena === "number") {
            cenyPodleZarizeni.set(cislo, cenikData.cena);
          }
        });

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
            cena:
              typeof record.cislo_zarizeni === "string"
                ? cenyPodleZarizeni.get(record.cislo_zarizeni) ?? null
                : null,
            opravaPoznamka: typeof record.oprava_poznamka === "string" ? record.oprava_poznamka : null,
            opravaDatum: record.oprava_datum instanceof Timestamp ? record.oprava_datum.toDate() : null,
            opravaUzivatelEmail:
              typeof record.oprava_uzivatel_email === "string" ? record.oprava_uzivatel_email : null,
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

  return { data, error, loading, setData };
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
  smazanoZmizeleCelkem: number;
  pridano: string[];
  aktualizovano: string[];
  smazano: string[];
  smazanoZmizele: string[];
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
            smazanoZmizeleCelkem:
              typeof pocty.smazano_zmizele === "number" ? pocty.smazano_zmizele : 0,
            pridano: toStringArray(polozky.pridano),
            aktualizovano: toStringArray(polozky.aktualizovano),
            smazano: toStringArray(polozky.smazano),
            smazanoZmizele: toStringArray(polozky.smazano_zmizele),
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

function DashboardOverview({ userEmail }: { userEmail: string }) {
  const { data, error, loading, setData } = useDashboardData();
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
  // Počítá se EFEKTIVNÍ výsledek (viz efektivniVysledekRevize) – ručně opravená
  // NOK zpráva se tak řadí do "OK", appka ji ale i tak dál zobrazuje s viditelnou
  // stopou opravy (viz VysledekReviseBadge), jen ji nepočítá jako otevřený problém.
  const pocetVysledekOk = data
    ? data.rows.filter((row) => efektivniVysledekRevize(row) === "OK").length
    : 0;
  const pocetVysledekNok = data
    ? data.rows.filter((row) => efektivniVysledekRevize(row) === "NOK").length
    : 0;
  const pocetVysledekKeKontrole = data
    ? data.rows.filter((row) => efektivniVysledekRevize(row) === "KE_KONTROLE").length
    : 0;
  const pocetNokOpraveno = data
    ? data.rows.filter((row) => row.vysledekRevize === "NOK" && !!row.opravaPoznamka).length
    : 0;

  const pocetSCenou = data ? data.rows.filter((row) => row.cena !== null).length : 0;
  const pocetBezCeny = data ? data.rows.length - pocetSCenou : 0;

  /**
   * Zapíše poznámku o ruční opravě NOK zprávy (viz VysledekReviseBadge) do
   * "planovane_revize" a hned aktualizuje i lokální stav (setData) – appka
   * díky tomu po uložení nemusí kvůli jedné opravené položce znovu stahovat
   * a přepočítávat celý (tisíce řádků velký) přehled.
   */
  const oznacitOpraveno = async (rowId: string, poznamka: string) => {
    const opravaDatum = new Date();
    await updateDoc(doc(db, PLAN_COLLECTION, rowId), {
      oprava_poznamka: poznamka,
      oprava_datum: Timestamp.fromDate(opravaDatum),
      oprava_uzivatel_email: userEmail,
    });
    setData((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((row) =>
              row.id === rowId
                ? { ...row, opravaPoznamka: poznamka, opravaDatum, opravaUzivatelEmail: userEmail }
                : row
            ),
          }
        : prev
    );
  };

  /**
   * Zapíše/upraví cenu zařízení přímo z přehledu (viz CenaBunka) – zapisuje
   * do STEJNÉ kolekce "cenik" jako import na stránce Ceník (spárováno podle
   * čísla zařízení, viz useDashboardData výše), takže ruční cena appce funguje
   * stejně jako cena z nahrané nabídky a případný pozdější import nabídky ji
   * podle svých pravidel (viz app/cenik/page.tsx) klidně přepíše.
   */
  const ulozitCenu = async (row: PlanRow, cena: number) => {
    const id = sanitizeDocId(row.cislo_zarizeni);
    if (!id) {
      throw new Error("Zařízení nemá platné číslo, cenu nelze uložit.");
    }
    await setDoc(
      doc(db, CENIK_COLLECTION, id),
      {
        cislo_zarizeni: row.cislo_zarizeni,
        popis: row.popis,
        cena,
        nahrano: Timestamp.fromDate(new Date()),
      },
      { merge: true }
    );
    setData((prev) =>
      prev
        ? { ...prev, rows: prev.rows.map((r) => (r.id === row.id ? { ...r, cena } : r)) }
        : prev
    );
  };

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
              className={`rounded-lg border-l-4 px-[18px] py-4 text-left transition-all ${
                isActive
                  ? // Plný sytý podklad V BARVĚ karty + bílý text, stejný vzor jako
                    // aktivní stav tlačítka "Nutno doplnit data" níž (border-status-missing
                    // bg-status-missing text-white) – appka barvy definuje přes sdílené
                    // tokeny v app/globals.css, takže "bg-<token>" existuje pro každou
                    // stejně jako "border-<token>" (odvozeno z s.color.split(" ")[0]).
                    // Silnější stín + mírné zvětšení navíc dají kartě dojem, že "vystoupí"
                    // nad ostatní (3D efekt), ne jen že změnila barvu.
                    `border-transparent shadow-xl scale-[1.03] ${s.color
                      .split(" ")[0]
                      .replace("border-", "bg-")}`
                  : `bg-white shadow-sm ${s.color.split(" ")[0]}`
              } ${clickable ? "cursor-pointer hover:shadow-md" : "cursor-default opacity-90"}`}
            >
              <div
                className={`text-[11px] font-bold uppercase tracking-wide ${
                  isActive ? "text-white/80" : "text-gray-500"
                }`}
              >
                {s.label}
              </div>
              <div
                className={`mt-1.5 text-[28px] font-bold ${isActive ? "text-white" : s.color.split(" ")[1]}`}
              >
                {s.value}
              </div>
              <div className={`mt-0.5 text-[11px] ${isActive ? "text-white/70" : "text-gray-400"}`}>
                {s.note}
              </div>
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
                ? `${importLogs.plan.pridanoCelkem} nových, ${importLogs.plan.aktualizovanoCelkem} aktualizovaných, ${importLogs.plan.smazanoCelkem} smazaných (INACTIVE)${
                    importLogs.plan.smazanoZmizeleCelkem > 0
                      ? `, ${importLogs.plan.smazanoZmizeleCelkem} smazaných (zmizelo ze zdroje)`
                      : ""
                  }`
                : "Zatím žádný záznam importu"
          }
          detailGroups={[
            { label: "Nově přidáno", items: importLogs?.plan?.pridano ?? [] },
            { label: "Aktualizováno", items: importLogs?.plan?.aktualizovano ?? [] },
            { label: "Smazáno (INACTIVE)", items: importLogs?.plan?.smazano ?? [] },
            { label: "Smazáno (zmizelo ze zdroje)", items: importLogs?.plan?.smazanoZmizele ?? [] },
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
        {data && data.stats.missingTermin > 0 && (
          <button
            onClick={() => setFilter("missing")}
            title="Záznamy z importu, u kterých se nepodařilo rozpoznat termín – je potřeba je ručně doplnit."
            className={`rounded-md border px-5 py-2.5 text-[13px] font-semibold tracking-wide transition-colors ${
              filter === "missing"
                ? "border-status-missing bg-status-missing text-white"
                : "border-status-missing/40 bg-zinc-50 text-status-missing hover:border-status-missing hover:bg-zinc-100"
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
                  ? "bg-red-600 text-white"
                  : "bg-red-50 text-red-700 hover:bg-red-100"
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
                  : "bg-green-50 text-green-700 hover:bg-green-100"
              }`}
            >
              S platnou revizní zprávou ({pocetSPlatnouZpravou})
            </button>
          </div>
        )}

        {data && (
          <div className="flex items-center gap-2 border-l border-gray-300 pl-3">
            <span className="text-[11px] font-bold uppercase tracking-wide text-navy">
              Výsledek revize
            </span>
            <div className="inline-flex overflow-hidden rounded-md border border-gray-300 text-[12.5px] font-semibold">
              <button
                onClick={() => setFilter("vysledek_ok")}
                title="Zobrazit jen zařízení s výsledkem revize OK"
                className={`px-3 py-2 transition-colors ${
                  filter === "vysledek_ok"
                    ? "bg-status-ok text-white"
                    : "bg-green-50 text-green-700 hover:bg-green-100"
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
                    : "bg-red-50 text-red-700 hover:bg-red-100"
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
                    : "bg-orange-50 text-orange-700 hover:bg-orange-100"
                }`}
              >
                Ke kontrole ({pocetVysledekKeKontrole})
              </button>
              <button
                onClick={() => setFilter("nok_opraveno")}
                title="Zobrazit jen NOK zařízení s ručně zaznamenanou opravou"
                className={`border-l border-gray-300 px-3 py-2 transition-colors ${
                  filter === "nok_opraveno"
                    ? "bg-blue-600 text-white"
                    : "bg-blue-50 text-blue-700 hover:bg-blue-100"
                }`}
              >
                NOK opraveno ({pocetNokOpraveno})
              </button>
            </div>
          </div>
        )}

        {data && (
          <div className="inline-flex overflow-hidden rounded-md border border-gray-300 text-[12.5px] font-semibold">
            <button
              onClick={() => setFilter("bez_ceny")}
              title="Zobrazit jen zařízení bez ceny v ceníku"
              className={`px-3 py-2 transition-colors ${
                filter === "bez_ceny"
                  ? "bg-red-600 text-white"
                  : "bg-red-50 text-red-700 hover:bg-red-100"
              }`}
            >
              Bez ceny ({pocetBezCeny})
            </button>
            <button
              onClick={() => setFilter("s_cenou")}
              title="Zobrazit jen zařízení s cenou v ceníku"
              className={`border-l border-gray-300 px-3 py-2 transition-colors ${
                filter === "s_cenou"
                  ? "bg-status-ok text-white"
                  : "bg-green-50 text-green-700 hover:bg-green-100"
              }`}
            >
              S cenou ({pocetSCenou})
            </button>
          </div>
        )}

        <div className="flex items-center gap-2 border-l border-gray-300 pl-3">
          <span className="text-[11px] font-bold uppercase tracking-wide text-navy">
            Vyhledávání:
          </span>
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Hledat podle čísla zařízení nebo popisu…"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-[13px] outline-none focus:border-accent focus:ring-1 focus:ring-accent sm:w-64"
          />
        </div>
      </div>

      {(() => {
        const visibleRows = data
          ? data.rows
              .filter((row) => {
                if (filter === "all") return true;
                if (filter === "bez_zpravy") return row.posledniRevizniZpravaUrl === null;
                if (filter === "s_zpravou") return row.posledniRevizniZpravaUrl !== null;
                if (filter === "vysledek_ok") return efektivniVysledekRevize(row) === "OK";
                if (filter === "vysledek_nok") return efektivniVysledekRevize(row) === "NOK";
                if (filter === "vysledek_ke_kontrole") return efektivniVysledekRevize(row) === "KE_KONTROLE";
                if (filter === "nok_opraveno") return row.vysledekRevize === "NOK" && !!row.opravaPoznamka;
                if (filter === "bez_ceny") return row.cena === null;
                if (filter === "s_cenou") return row.cena !== null;
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
              <div className="flex items-center gap-3">
                <span className="text-[12px] font-normal text-white/60">
                  {data ? `${visibleRows.length} záznamů` : loading ? "Načítám…" : "0 záznamů"}
                </span>
                {data && visibleRows.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      exportujDoExcelu(visibleRows, startOfToday, warnUntil, filter, trimmedSearch)
                    }
                    title="Exportovat právě zobrazené záznamy (podle aktivního filtru a hledání) do Excelu"
                    className="rounded-md border border-white/30 bg-white/10 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-white transition-colors hover:bg-white/20"
                  >
                    Export do Excelu
                  </button>
                )}
              </div>
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
                  : "Zatím žádná zařízení. Nahraj plán revizí (.xls) v záložce „Import a kontrola“, ať se tu objeví přehled."}
              </div>
            )}

            {!loading && data && visibleRows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500">
                      <th className="py-2 pl-[18px] pr-4 font-semibold">Číslo zařízení</th>
                      <th className="py-2 pr-4 font-semibold">Popis</th>
                      <th className="py-2 pr-4 font-semibold">Cena</th>
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
                            <CenaBunka row={row} onUlozitCenu={(cena) => ulozitCenu(row, cena)} />
                          </td>
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
                            <VysledekReviseBadge
                              row={row}
                              onOznacitOpravene={(poznamka) => oznacitOpraveno(row.id, poznamka)}
                            />
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

            <DashboardOverview userEmail={user.email ?? "neznámý uživatel"} />
          </div>
        </div>
      )}
    </AuthGate>
  );
}
