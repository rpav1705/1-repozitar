"use client";

import { useEffect, useRef, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";
import { db, storage } from "@/lib/firebase";
import {
  addDoc,
  collection,
  doc,
  DocumentData,
  getDocs,
  query,
  QueryDocumentSnapshot,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { getBytes, getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { parsePlanWorkbook, ParsedPlanRow, ParseSkip } from "@/lib/xlsxImport";
import { parseRevizniZpravyPdf, ParsedRevizniZprava, VysledekRevize } from "@/lib/pdfRevizniZprava";
import { revizniZpravaToFirestoreFields } from "@/lib/revizniZpravyFirestore";
import { smazNeaktivniZarizeni, synchronizujHistoriiZarizeni } from "@/lib/revizniZpravyHistorie";
import { describeSaveError } from "@/lib/friendlyError";
import { yieldToMainThread } from "@/lib/yieldToMainThread";

// Firestore dovoluje max. 500 zápisů v jednom writeBatch – zápis proto
// rozdělíme do dávek po BATCH_SIZE a commitneme je postupně.
const BATCH_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Firestore ID nesmí obsahovat "/" a nesmí to být přesně "." nebo "..".
function sanitizeDocId(raw: string): string {
  const cleaned = raw.replace(/\//g, "_").trim();
  return cleaned === "." || cleaned === ".." ? "" : cleaned;
}

// Stejná logika jako v handleSave – použité tady jen na náhled v UI, ať jde
// vidět (bez otevírání konzole), jaké ID se skutečně uloží a jestli je stabilní
// mezi opakovanými importy stejného souboru.
function previewDocId(row: ParsedPlanRow): string {
  const puId = row.pu ? sanitizeDocId(row.pu) : "";
  return puId || "(náhodné – chybí PÚ)";
}

type NeaktivniVysledek = {
  zpracovano: number;
  planSmazano: number;
  zpravSmazano: number;
  souboruSmazano: number;
  bezPu: number;
};

function PlanUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ParsedPlanRow[]>([]);
  const [skipped, setSkipped] = useState<ParseSkip[]>([]);
  const [inactiveRows, setInactiveRows] = useState<ParsedPlanRow[]>([]);
  const [status, setStatus] = useState<"idle" | "parsing" | "parsed" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [savedCount, setSavedCount] = useState(0);
  const [neaktivniVysledek, setNeaktivniVysledek] = useState<NeaktivniVysledek | null>(null);

  const missingTerminCount = rows.filter((row) => !row.termin).length;

  const handleParse = async () => {
    if (!file) return;
    setStatus("parsing");
    setError("");
    try {
      const buffer = await file.arrayBuffer();
      const result = parsePlanWorkbook(buffer);
      setRows(result.rows);
      setSkipped(result.skipped);
      setInactiveRows(result.inactive);
      setNeaktivniVysledek(null);
      setStatus("parsed");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Soubor se nepodařilo zpracovat kvůli neznámé chybě. Zkus to prosím znovu."
      );
      setStatus("error");
    }
  };

  const handleSave = async () => {
    setStatus("saving");
    setError("");
    setSavedCount(0);
    setNeaktivniVysledek(null);
    try {
      const col = collection(db, "planovane_revize");
      let saved = 0;
      for (const batchRows of chunk(rows, BATCH_SIZE)) {
        const batch = writeBatch(db);
        batchRows.forEach((row) => {
          // Stabilní ID podle "PÚ" (Maximo PM číslo) – opakovaný import stejného
          // řádku tak existující záznam přepíše, místo aby vytvořil duplicitu.
          const puId = row.pu ? sanitizeDocId(row.pu) : "";
          const ref = puId ? doc(col, puId) : doc(col);
          batch.set(ref, {
            cislo_zarizeni: row.cislo_zarizeni,
            popis: row.popis,
            termin: row.termin ? Timestamp.fromDate(row.termin) : null,
            frekvence: row.frekvence,
            jednotky_frekvence: row.jednotky_frekvence,
            pu: row.pu,
            // Chybějící termín se neztrácí zahozením řádku, ale označením stavu –
            // je potřeba ho ručně doplnit (viz "Nutno doplnit data" na dashboardu).
            stav: row.termin ? "cekajici" : "chybi_termin",
          });
        });
        await batch.commit();
        saved += batchRows.length;
        setSavedCount(saved);
      }

      // Řádky se "Stav" = "INACTIVE" appka neimportuje – naopak podle nich
      // smaže odpovídající existující záznam (a jeho revizní zprávy, pokud
      // u zařízení nezůstal žádný jiný aktivní typ revize), viz
      // smazNeaktivniZarizeni. Díky stabilnímu ID podle "PÚ" se tak i jednou
      // provedený import zpětně postará o úklid zařízení, která byla dřív
      // aktivní a teď už nejsou.
      let planSmazano = 0;
      let zpravSmazano = 0;
      let souboruSmazano = 0;
      let bezPu = 0;
      for (const row of inactiveRows) {
        const puId = row.pu ? sanitizeDocId(row.pu) : "";
        if (!puId) {
          bezPu += 1;
          continue;
        }
        const vysledek = await smazNeaktivniZarizeni(puId, row.cislo_zarizeni);
        if (vysledek.planSmazan) planSmazano += 1;
        zpravSmazano += vysledek.smazanoZaznamu;
        souboruSmazano += vysledek.smazanoSouboru;
      }
      if (inactiveRows.length > 0) {
        setNeaktivniVysledek({
          zpracovano: inactiveRows.length,
          planSmazano,
          zpravSmazano,
          souboruSmazano,
          bezPu,
        });
      }

      setStatus("saved");
    } catch (err) {
      setError(describeSaveError(err));
      setStatus("error");
    }
  };

  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-sm">
      <div className="bg-navy px-[18px] py-2.5 text-[13px] font-bold text-white">
        Import plánu revizí (.xls / .xlsx)
      </div>
      <div className="flex flex-col gap-4 px-[18px] py-5">
        <p className="text-[12.5px] text-gray-500">
          Nahraj export plánu revizí (obdoba exportu z Maxima) se sloupci pro číslo zařízení/aktiva,
          popis a termín &bdquo;Předpokládané dokončení&ldquo;. Záznamy se uloží do kolekce{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5">planovane_revize</code> se stavem{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5">cekajici</code>. Řádky, u kterých se
          nepodaří rozpoznat termín, se uloží taky – se stavem{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5">chybi_termin</code>, ať se dají dohledat
          a ručně doplnit. Řádky se sloupcem &bdquo;Stav&ldquo; = &bdquo;INACTIVE&ldquo; se NEnaimportují –
          existující záznam pro dané zařízení (a jeho revizní zprávy) se naopak smaže, appka
          neaktivní zařízení nedrží.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".xls,.xlsx"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setRows([]);
              setSkipped([]);
              setInactiveRows([]);
              setNeaktivniVysledek(null);
              setStatus("idle");
            }}
            className="text-[13px]"
          />
          <button
            onClick={handleParse}
            disabled={!file || status === "parsing"}
            className="rounded-md bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "parsing" ? "Zpracovávám…" : "Zpracovat soubor"}
          </button>
        </div>

        {status === "parsing" && (
          <p className="rounded-md bg-blue-50 px-3 py-2 text-[12.5px] text-blue-700">
            Zpracovávám soubor…
          </p>
        )}

        {status === "saving" && (
          <p className="rounded-md bg-blue-50 px-3 py-2 text-[12.5px] text-blue-700">
            Ukládám záznamy do databáze… ({savedCount}/{rows.length})
          </p>
        )}

        {status === "error" && error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-600">{error}</p>
        )}

        {(status === "parsed" || status === "saving" || status === "saved") && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-[12.5px] text-blue-700">
              <span>
                Nalezeno {rows.length} záznamů k importu: {rows.length - missingTerminCount} v pořádku
                {missingTerminCount > 0 &&
                  `, ${missingTerminCount} bez termínu (budou uloženy, ale je potřeba je ručně doplnit)`}
                {inactiveRows.length > 0 &&
                  ` — ${inactiveRows.length} neaktivních zařízení (Stav = INACTIVE) se NEimportuje, existující záznamy se smažou`}
                {skipped.length > 0 && ` — přeskočeno ${skipped.length} prázdných řádků`}.
              </span>
              {status !== "saved" && (
                <button
                  onClick={handleSave}
                  disabled={(rows.length === 0 && inactiveRows.length === 0) || status === "saving"}
                  className="rounded-md bg-accent px-4 py-1.5 text-[12.5px] font-bold tracking-wide text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === "saving"
                    ? "Ukládám…"
                    : inactiveRows.length > 0
                      ? `Uložit ${rows.length} záznamů (+ smazat ${inactiveRows.length} neaktivních)`
                      : `Uložit ${rows.length} záznamů`}
                </button>
              )}
            </div>

            {status === "saved" && (
              <p className="rounded-md bg-green-50 px-3 py-2 text-[12.5px] font-semibold text-status-ok">
                Úspěšně uloženo {rows.length} záznamů do databáze (planovane_revize).
              </p>
            )}

            {status === "saved" && neaktivniVysledek && (
              <p className="rounded-md bg-gray-100 px-3 py-2 text-[12.5px] text-gray-600">
                Neaktivní zařízení: zpracováno {neaktivniVysledek.zpracovano}, smazáno{" "}
                {neaktivniVysledek.planSmazano} záznamů z plánu, {neaktivniVysledek.zpravSmazano}{" "}
                revizních zpráv a {neaktivniVysledek.souboruSmazano} PDF souborů ze Storage
                {neaktivniVysledek.bezPu > 0 &&
                  ` (${neaktivniVysledek.bezPu} nešlo automaticky spárovat – chybí PÚ)`}
                .
              </p>
            )}

            {inactiveRows.length > 0 && (
              <details className="text-[12px] text-gray-500">
                <summary className="cursor-pointer font-semibold">
                  Neaktivní zařízení (Stav = INACTIVE) – nebudou naimportována
                </summary>
                <ul className="mt-1 list-inside list-disc">
                  {inactiveRows.slice(0, 20).map((row, i) => (
                    <li key={i}>
                      {row.cislo_zarizeni || "(bez čísla zařízení)"} — {row.popis || "—"} (PÚ{" "}
                      {row.pu || "chybí"})
                    </li>
                  ))}
                </ul>
                {inactiveRows.length > 20 && (
                  <p className="mt-1 text-[11px] text-gray-400">
                    Zobrazeno prvních 20 z {inactiveRows.length}.
                  </p>
                )}
              </details>
            )}

            {skipped.length > 0 && (
              <details className="text-[12px] text-gray-500">
                <summary className="cursor-pointer font-semibold">Přeskočené řádky</summary>
                <ul className="mt-1 list-inside list-disc">
                  {skipped.map((s, i) => (
                    <li key={i}>
                      řádek {s.row}: {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {rows.length > 0 && (
              <details className="text-[12px] text-gray-500">
                <summary className="cursor-pointer font-semibold">
                  Náhled Firestore ID (diagnostika duplicit při reimportu)
                </summary>
                <ul className="mt-1 list-inside list-disc">
                  {rows.slice(0, 5).map((row, i) => (
                    <li key={i}>
                      {row.cislo_zarizeni} →{" "}
                      <code className="rounded bg-gray-100 px-1 py-0.5">{previewDocId(row)}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500">
                      <th className="py-1.5 pr-4 font-semibold">Číslo zařízení</th>
                      <th className="py-1.5 pr-4 font-semibold">Popis</th>
                      <th className="py-1.5 pr-4 font-semibold">Termín</th>
                      <th className="py-1.5 pr-4 font-semibold">Frekvence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 20).map((row, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="py-1.5 pr-4">{row.cislo_zarizeni}</td>
                        <td className="py-1.5 pr-4">{row.popis}</td>
                        <td className="py-1.5 pr-4">
                          {row.termin ? (
                            row.termin.toLocaleDateString("cs-CZ")
                          ) : (
                            <span className="font-semibold text-status-missing">chybí termín</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-4">
                          {row.frekvence !== null
                            ? `${row.frekvence} ${row.jednotky_frekvence}`.trim()
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 20 && (
                  <p className="mt-1 text-[11px] text-gray-400">
                    Zobrazeno prvních 20 z {rows.length} záznamů.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

type ParovaniStav = "shoda" | "bez_shody" | "vice_shod";

type ProcessedZprava = {
  soubor: string;
  stranka: number;
  cislo_zarizeni: string;
  datum_provedeni: Date;
  novy_termin: Date;
  celkove_hodnoceni: string;
  technik_jmeno: string | null;
  technik_cislo_opravneni: string | null;
  parovani_stav: ParovaniStav;
  posledni_revize_vcas: boolean | null;
  /**
   * Termín skutečně přečtený zpátky z planovane_revize hned po zápisu
   * (jen u "shoda") – přímý důkaz, že updateDoc() opravdu zapsal do
   * Firestore, ne jen náhled toho, co appka POSLALA.
   */
  overenyTerminVPlanu: Date | null;
};

type SkippedPageEntry = {
  soubor: string;
  stranka: number;
  duvod: string;
};

const PAROVANI_LABELS: Record<ParovaniStav, { label: string; className: string }> = {
  shoda: { label: "Spárováno a aktualizováno", className: "text-status-ok" },
  bez_shody: { label: "Bez odpovídajícího záznamu v plánu", className: "text-status-warn" },
  vice_shod: { label: "Víc shod – vyžaduje ruční kontrolu", className: "text-status-missing" },
};

function sanitizeStoragePathSegment(name: string): string {
  return name.replace(/\//g, "_");
}

function pluralizeSoubor(count: number): string {
  if (count === 1) return "soubor";
  if (count >= 2 && count <= 4) return "soubory";
  return "souborů";
}

function RevizniZpravyUpload() {
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<"idle" | "processing" | "done">("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [processed, setProcessed] = useState<ProcessedZprava[]>([]);
  const [skippedPages, setSkippedPages] = useState<SkippedPageEntry[]>([]);

  const handleProcess = async () => {
    if (files.length === 0) return;
    setStatus("processing");
    setProcessed([]);
    setSkippedPages([]);
    setProgress({ done: 0, total: files.length });

    const allProcessed: ProcessedZprava[] = [];
    const allSkipped: SkippedPageEntry[] = [];
    // Čísla zařízení dotčená touhle dávkou – po zápisu všech zpráv se u
    // každého z nich spustí synchronizace historie (prořezání na poslední 2
    // + dosazení skutečně nejnovější zprávy do plánu), viz komentář u
    // synchronizujHistoriiZarizeni.
    const dotcenaZarizeni = new Set<string>();

    for (const file of files) {
      try {
        const buffer = await file.arrayBuffer();
        const { zpravy, preskoceno } = await parseRevizniZpravyPdf(buffer);

        for (const p of preskoceno) {
          allSkipped.push({ soubor: file.name, stranka: p.stranka, duvod: p.duvod });
        }

        if (zpravy.length > 0) {
          // Rozdělení jednotlivých stránek do samostatných PDF by vyžadovalo další
          // knihovnu – ukládáme proto celý nahraný soubor jednou a každá z něj
          // rozpoznaná revizní zpráva na něj odkazuje i s číslem stránky.
          const storagePath = `revizni_zpravy/${Date.now()}_${sanitizeStoragePathSegment(file.name)}`;
          const fileRef = ref(storage, storagePath);
          await uploadBytes(fileRef, buffer, { contentType: "application/pdf" });
          const pdf_url = await getDownloadURL(fileRef);

          for (const zprava of zpravy) {
            const planQuery = query(
              collection(db, "planovane_revize"),
              where("cislo_zarizeni", "==", zprava.cislo_zarizeni)
            );
            const matchSnap = await getDocs(planQuery);
            const planovane_revize_ids = matchSnap.docs.map((d) => d.id);

            let parovani_stav: ParovaniStav;
            let posledni_revize_vcas: boolean | null = null;

            if (matchSnap.docs.length === 0) {
              parovani_stav = "bez_shody";
            } else if (matchSnap.docs.length > 1) {
              // Zpráva neurčuje, kterého konkrétního plánu (typu revize) se týká –
              // při víc shodách proto nic automaticky needitujeme, jen upozorníme.
              parovani_stav = "vice_shod";
            } else {
              parovani_stav = "shoda";
              const existingTermin = matchSnap.docs[0].data().termin;
              const puvodniTermin = existingTermin instanceof Timestamp ? existingTermin.toDate() : null;
              posledni_revize_vcas = puvodniTermin ? zprava.datum_provedeni <= puvodniTermin : null;
            }

            await addDoc(collection(db, "revizni_zpravy"), {
              ...revizniZpravaToFirestoreFields(zprava),
              stranka: zprava.stranka,
              soubor_nazev: file.name,
              pdf_storage_path: storagePath,
              pdf_url,
              nahrano: Timestamp.fromDate(new Date()),
              planovane_revize_ids,
              parovani_stav,
              posledni_revize_vcas,
            });
            dotcenaZarizeni.add(zprava.cislo_zarizeni);

            allProcessed.push({
              soubor: file.name,
              stranka: zprava.stranka,
              cislo_zarizeni: zprava.cislo_zarizeni,
              datum_provedeni: zprava.datum_provedeni,
              novy_termin: zprava.novy_termin,
              celkove_hodnoceni: zprava.celkove_hodnoceni,
              technik_jmeno: zprava.technik_jmeno,
              technik_cislo_opravneni: zprava.technik_cislo_opravneni,
              parovani_stav,
              posledni_revize_vcas,
              // Dopočítá se až po synchronizaci historie níž – tou dobou už
              // je jasné, jestli tahle konkrétní zpráva zůstala tou
              // nejnovější ponechanou, nebo ji předběhla jiná z dávky.
              overenyTerminVPlanu: null,
            });
          }
        }
      } catch (err) {
        // Chyba tu může být z libovolné fáze (čtení PDF, upload do Storage,
        // dotaz/zápis do Firestore) – ukážeme rovnou její vlastní zprávu,
        // ne obecnou "nepodařilo se uložit" (ta by mohla být zavádějící).
        allSkipped.push({
          soubor: file.name,
          stranka: 0,
          duvod:
            err instanceof Error && err.message
              ? err.message
              : "soubor se nepodařilo zpracovat kvůli neznámé chybě",
        });
      }

      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    // Prořízne historii (starší než poslední 2 podle data provedení pryč) a
    // dosadí do plánu skutečně nejnovější zprávu za každé dotčené zařízení –
    // teprve teď, po zápisu VŠECH zpráv z týhle dávky, ať pořadí zpracování
    // souborů neovlivní výsledek.
    const overenyTerminByZarizeni = new Map<string, Date | null>();
    for (const cislo of dotcenaZarizeni) {
      await synchronizujHistoriiZarizeni(cislo);
      const planSnap = await getDocs(
        query(collection(db, "planovane_revize"), where("cislo_zarizeni", "==", cislo))
      );
      if (planSnap.docs.length === 1) {
        const t = planSnap.docs[0].data().termin;
        overenyTerminByZarizeni.set(cislo, t instanceof Timestamp ? t.toDate() : null);
      }
    }
    for (const p of allProcessed) {
      if (p.parovani_stav === "shoda") {
        p.overenyTerminVPlanu = overenyTerminByZarizeni.get(p.cislo_zarizeni) ?? null;
      }
    }

    setProcessed(allProcessed);
    setSkippedPages(allSkipped);
    setStatus(allProcessed.length === 0 && allSkipped.length === 0 ? "idle" : "done");
  };

  const shodaCount = processed.filter((p) => p.parovani_stav === "shoda").length;
  const bezShodyCount = processed.filter((p) => p.parovani_stav === "bez_shody").length;
  const viceShodCount = processed.filter((p) => p.parovani_stav === "vice_shod").length;

  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-sm">
      <div className="bg-navy px-[18px] py-2.5 text-[13px] font-bold text-white">
        Import revizních zpráv (PDF)
      </div>
      <div className="flex flex-col gap-4 px-[18px] py-5">
        <p className="text-[12.5px] text-gray-500">
          Nahraj jednu nebo víc revizních zpráv (protokol o pravidelné revizi dle ČSN 33 1600 ed.2,
          program ILLKO Studio) – ať už samostatné PDF pro jedno zařízení, nebo jeden soubor s
          revizními zprávami pro víc zařízení (jedna na stránku). Číslo zařízení a ostatní údaje se
          čtou výhradně z obsahu PDF, ne z názvu souboru. Úspěšně rozpoznané zprávy se spárují s
          plánem revizí (kolekce <code className="rounded bg-gray-100 px-1 py-0.5">planovane_revize</code>{" "}
          podle pole <code className="rounded bg-gray-100 px-1 py-0.5">cislo_zarizeni</code>) a uloží
          se do kolekce <code className="rounded bg-gray-100 px-1 py-0.5">revizni_zpravy</code>.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept="application/pdf"
            multiple
            onChange={(e) => {
              setFiles(Array.from(e.target.files ?? []));
              setProcessed([]);
              setSkippedPages([]);
              setStatus("idle");
            }}
            className="text-[13px]"
          />
          <button
            onClick={handleProcess}
            disabled={files.length === 0 || status === "processing"}
            className="rounded-md bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "processing"
              ? `Zpracovávám… (${progress.done}/${progress.total})`
              : files.length > 0
                ? `Zpracovat ${files.length} ${pluralizeSoubor(files.length)}`
                : "Zpracovat soubory"}
          </button>
        </div>

        {status === "done" && (
          <>
            <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-[12.5px] text-blue-700">
              Rozpoznáno {processed.length} revizních zpráv: {shodaCount} spárováno a aktualizováno
              {bezShodyCount > 0 && `, ${bezShodyCount} bez odpovídajícího záznamu v plánu`}
              {viceShodCount > 0 && `, ${viceShodCount} vyžaduje ruční kontrolu (víc shod)`}
              {skippedPages.length > 0 && ` — nerozpoznáno ${skippedPages.length} stránek/souborů`}.
            </div>

            {skippedPages.length > 0 && (
              <details className="text-[12px] text-gray-500">
                <summary className="cursor-pointer font-semibold">Nerozpoznané stránky/soubory</summary>
                <ul className="mt-1 list-inside list-disc">
                  {skippedPages.map((s, i) => (
                    <li key={i}>
                      {s.soubor}
                      {s.stranka > 0 ? `, strana ${s.stranka}` : ""}: {s.duvod}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {processed.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500">
                      <th className="py-1.5 pr-4 font-semibold">Číslo zařízení</th>
                      <th className="py-1.5 pr-4 font-semibold">Provedeno</th>
                      <th className="py-1.5 pr-4 font-semibold">Nový termín</th>
                      <th className="py-1.5 pr-4 font-semibold">Hodnocení</th>
                      <th className="py-1.5 pr-4 font-semibold">Technik</th>
                      <th className="py-1.5 pr-4 font-semibold">Číslo oprávnění</th>
                      <th className="py-1.5 pr-4 font-semibold">Párování</th>
                      <th className="py-1.5 pr-4 font-semibold">Termín v plánu (ověřeno)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processed.map((p, i) => {
                      const terminSedi =
                        p.parovani_stav !== "shoda" ||
                        (p.overenyTerminVPlanu !== null &&
                          p.overenyTerminVPlanu.getTime() === p.novy_termin.getTime());
                      return (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="py-1.5 pr-4">{p.cislo_zarizeni}</td>
                        <td className="py-1.5 pr-4">{p.datum_provedeni.toLocaleDateString("cs-CZ")}</td>
                        <td className="py-1.5 pr-4">{p.novy_termin.toLocaleDateString("cs-CZ")}</td>
                        <td className="py-1.5 pr-4">{p.celkove_hodnoceni || "—"}</td>
                        <td className="py-1.5 pr-4">{p.technik_jmeno || "—"}</td>
                        <td className="py-1.5 pr-4">{p.technik_cislo_opravneni || "—"}</td>
                        <td className={`py-1.5 pr-4 font-semibold ${PAROVANI_LABELS[p.parovani_stav].className}`}>
                          {PAROVANI_LABELS[p.parovani_stav].label}
                        </td>
                        <td className={`py-1.5 pr-4 ${terminSedi ? "" : "font-semibold text-status-overdue"}`}>
                          {p.parovani_stav !== "shoda"
                            ? "—"
                            : p.overenyTerminVPlanu
                              ? p.overenyTerminVPlanu.toLocaleDateString("cs-CZ")
                              : "chybí i po zápisu!"}
                          {!terminSedi && " (neshoduje se s novým termínem výše)"}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

type ReprocessStav = "aktualizovano" | "aktualizovano_i_v_planu" | "chyba";

type ReprocessResult = {
  id: string;
  soubor: string;
  stranka: number;
  cislo_zarizeni: string;
  stav: ReprocessStav;
  poznamka: string;
  /** Jen u úspěšně přepočítaných zpráv (viz VysledekRevize v lib/pdfRevizniZprava.ts). */
  vysledekRevize?: VysledekRevize;
};

const REPROCESS_STAV_LABELS: Record<ReprocessStav, { label: string; className: string }> = {
  aktualizovano: { label: "Aktualizováno", className: "text-status-ok" },
  aktualizovano_i_v_planu: { label: "Aktualizováno i v plánu", className: "text-status-ok" },
  chyba: { label: "Selhalo", className: "text-status-overdue" },
};

const VYSLEDEK_REVIZE_LABELS: Record<VysledekRevize, { label: string; className: string }> = {
  OK: { label: "OK", className: "text-status-ok" },
  NOK: { label: "NOK", className: "text-status-overdue" },
  KE_KONTROLE: { label: "Ke kontrole", className: "text-status-warn" },
};

type PruneSouhrn = {
  zarizeni: number;
  zarizeniSMazanim: number;
  smazanoZaznamu: number;
  smazanoSouboru: number;
};

// Diagnostická tabulka výsledků ukazuje jen posledních RESULTS_DISPLAY_LIMIT
// zpracovaných zpráv – u dávek v řádu tisíců by appka jinak při KAŽDÉM dalším
// zpracovaném souboru kopírovala a znovu vykreslovala pořád rostoucí pole
// (a k tomu ho ještě celé profiltrovávala kvůli souhrnným počtům, viz
// VysledkySouhrn níž) – to prohlížeč při stovkách/tisících položek reálně
// dokázalo na dlouho zaseknout ("Page Unresponsive"). Souhrnné počty se proto
// počítají průběžně (o(1) na položku), nezávisle na tom, co se zrovna
// zobrazuje v tabulce.
const RESULTS_DISPLAY_LIMIT = 300;
const KE_KONTROLE_LIST_LIMIT = 50;

// Zpracování se nespouští na celou frontu najednou, ale po dávkách max.
// REPROCESS_BATCH_SIZE souborů (skupin) – u front v řádu tisíců appka jinak
// celou dobu běhu držela v paměti kompletní seznam VŠECH zbývajících skupin
// (Map/pole s odkazy na Firestore dokumenty pro každou z nich). Mezi dávkami
// appka uvolní referenci na tu právě dokončenou (viz groupBatches níž) a na
// krátko počká – dál to ale z pohledu uživatele vypadá jako jedno souvislé
// zpracování, jen interně rozporcované na menší kousky.
//
// POZOR: samotná pauza mezi dávkami NENÍ hlavní ochrana proti "Stránka
// nereaguje" – tou je yieldToMainThread() PO KAŽDÉM jednotlivém souboru (viz
// worker níž a komentář tam), který hlavnímu vláknu vrací řízení mnohem
// častěji, přímo uvnitř dávky. Menší dávka tu slouží hlavně jemnějšímu
// checkpointu/uvolňování paměti, ne primárně plynulosti UI.
const REPROCESS_BATCH_SIZE = 50;
const REPROCESS_BATCH_PAUSE_MS = 1500;

type VysledkySouhrn = {
  zpracovano: number;
  uspesne: number;
  chyba: number;
  ok: number;
  nok: number;
  keKontrole: number;
  /** Jen ukázka čísel zařízení (max KE_KONTROLE_LIST_LIMIT), ne úplný seznam. */
  keKontroleZarizeni: string[];
};

const PRAZDNY_VYSLEDKY_SOUHRN: VysledkySouhrn = {
  zpracovano: 0,
  uspesne: 0,
  chyba: 0,
  ok: 0,
  nok: 0,
  keKontrole: 0,
  keKontroleZarizeni: [],
};

/**
 * U každého čísla zařízení appka drží nejvýš HISTORIE_LIMIT (2) revizních
 * zpráv – aktuální a předchozí, viz synchronizujHistoriiZarizeni. Ta
 * předchozí je čistě historická (appka z ní nic dál nevyhodnocuje, jen na ni
 * odkazuje šedý odznak "Předchozí revizní zpráva"), takže ji nemá smysl při
 * přeparsování zbytečně znovu stahovat – vybere se proto jen ta nejnovější
 * (podle "datum_provedeni") z každé skupiny. Zprávy bez rozpoznatelného
 * čísla zařízení se ponechají všechny – u nich nejde "aktuální" určit, takže
 * je bezpečnější je nepřeskakovat.
 */
function vyberAktualniZpravy(
  docs: QueryDocumentSnapshot<DocumentData>[]
): QueryDocumentSnapshot<DocumentData>[] {
  const podleZarizeni = new Map<string, QueryDocumentSnapshot<DocumentData>[]>();
  const bezCisla: QueryDocumentSnapshot<DocumentData>[] = [];

  for (const d of docs) {
    const cislo = d.data().cislo_zarizeni;
    if (typeof cislo === "string" && cislo) {
      const skupina = podleZarizeni.get(cislo) ?? [];
      skupina.push(d);
      podleZarizeni.set(cislo, skupina);
    } else {
      bezCisla.push(d);
    }
  }

  const aktualniDatum = (d: QueryDocumentSnapshot<DocumentData>) => {
    const hodnota = d.data().datum_provedeni;
    return hodnota instanceof Timestamp ? hodnota.toMillis() : -Infinity;
  };

  const vybrane = [...bezCisla];
  for (const skupina of podleZarizeni.values()) {
    vybrane.push(
      skupina.reduce((nejnovejsi, d) => (aktualniDatum(d) > aktualniDatum(nejnovejsi) ? d : nejnovejsi))
    );
  }
  return vybrane;
}

// Nastaví se jen při úspěšném zápisu z TOHOHLE tlačítka (ne při prvním
// nahrání – viz REPROCESS_MARKER_FIELD komentář u jeZpracovanoReprocessem
// níž), takže nově nahrané zprávy jím zpočátku nemají označené.
const REPROCESS_MARKER_FIELD = "naposledy_zpracovano_reprocessem";

/**
 * Jestli tuhle zprávu tlačítko "Znovu zpracovat" už někdy úspěšně
 * zpracovalo. Nejde o to, jestli má zpráva vyplněná parsovaná pole – ta má
 * vyplněná i úplně nová, čerstvě nahraná zpráva (parsuje se rovnou při
 * nahrání). Jde o to, jestli ji tohle konkrétní tlačítko už "viděla" – ať
 * default dávka ("nové") obsahuje jen zprávy, které ještě nikdy neprošly
 * přeparsováním touhle cestou (typicky čerstvě přibylé), a ne všechny
 * tisíce, co se stejně nezměnily od posledního běhu.
 */
function jeZpracovanoReprocessem(d: QueryDocumentSnapshot<DocumentData>): boolean {
  return d.data()[REPROCESS_MARKER_FIELD] instanceof Timestamp;
}

type ReprocessMod = "nove" | "vse";

/**
 * Modulová (ne komponentová) proměnná – běh handleReprocess je jen plain
 * async funkce volaná z onClick, na React lifecycle komponenty NENÍ nijak
 * vázaná. Když uživatel uvnitř appky přejde na jinou stránku (Next.js
 * klientská navigace jen překreslí React strom, needělá full reload téhle
 * karty prohlížeče), RevizniZpravyReprocess se odmountuje, ale rozdělaný
 * handleReprocess doběhne dál na pozadí – jen ztratí spojení na setState
 * (ty se stanou tichým no-opem). Modulová proměnná přežije tohle
 * odmountování/zamountování, takže i nově zamountovaná komponenta (např.
 * po návratu zpět na "/nahrat") pozná, že už něco běží, a nedovolí
 * uživateli omylem spustit druhou souběžnou dávku ve stejné kartě
 * prohlížeče. Chrání to JEN proti tomuhle scénáři – ne proti druhé
 * otevřené kartě/oknu prohlížeči (tam je proměnná úplně nezávislá, viz
 * varování v UI níž).
 */
let bezicíZpracovani: { rezim: ReprocessMod; zacatek: Date } | null = null;

// Checkpoint rozdělané dávky – v localStorage, ať přežije i zavření karty
// nebo pád prohlížeče uprostřed běhu (na rozdíl od bezicíZpracovani výše,
// která je jen v paměti a mizí s kartou). Ukládá se průběžně po každé
// úspěšně zpracované zprávě, ne až na konci.
const REPROCESS_CHECKPOINT_KEY = "revizniZpravyReprocessCheckpoint";

type ReprocessCheckpoint = {
  mod: ReprocessMod;
  /** ID dokumentů "revizni_zpravy", které tenhle běh (i přes případná
   *  přerušení/pokračování) už úspěšně zpracoval. */
  hotoveIds: string[];
  /** ISO datum poslední aktualizace – jen informativní, appka checkpoint
   *  nikdy sama neignoruje jen kvůli stáří (viz UI volba Pokračovat/Začít
   *  znovu, kterou má uživatel plně pod kontrolou). */
  aktualizovano: string;
};

function nacistReprocessCheckpoint(): ReprocessCheckpoint | null {
  try {
    const raw = localStorage.getItem(REPROCESS_CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      (parsed.mod === "nove" || parsed.mod === "vse") &&
      Array.isArray(parsed.hotoveIds) &&
      parsed.hotoveIds.every((id: unknown) => typeof id === "string") &&
      typeof parsed.aktualizovano === "string"
    ) {
      return parsed as ReprocessCheckpoint;
    }
    return null;
  } catch {
    return null;
  }
}

function ulozitReprocessCheckpoint(checkpoint: ReprocessCheckpoint) {
  try {
    localStorage.setItem(REPROCESS_CHECKPOINT_KEY, JSON.stringify(checkpoint));
  } catch {
    // localStorage může být nedostupný (soukromé okno, zakázané úložiště…) –
    // checkpoint se prostě neuloží. Přerušení/pokračování přes zavření karty
    // pak nebude fungovat, ale samotné zpracování tím ohrožené není.
  }
}

function smazatReprocessCheckpoint() {
  try {
    localStorage.removeItem(REPROCESS_CHECKPOINT_KEY);
  } catch {
    // viz ulozitReprocessCheckpoint
  }
}

/**
 * Znovu stáhne a naparsuje PDF revizních zpráv, které appka už má uložené ve
 * Firebase Storage (odkaz na ně drží kolekce "revizni_zpravy"), a přepíše
 * jimi extrahovaná pole – ať uživatel nemusí soubory znovu ručně nahrávat
 * pokaždé, když přibude nové extrahované pole (nebo se opraví parsování).
 * Zpracovává jen AKTUÁLNÍ zprávu u každého zařízení (viz
 * vyberAktualniZpravy) – tu předchozí appka dál drží jako historii, ale
 * nikde ji nevyhodnocuje, takže by bylo zbytečné ji znovu stahovat. Víc
 * revizních zpráv může odkazovat na stejný nahraný soubor (víc zařízení na
 * stránku) – soubor se proto stahuje a parsuje jen jednou na skupinu.
 *
 * Dva režimy (viz ReprocessMod): "nove" (výchozí, přes hlavní tlačítko)
 * zpracuje jen zprávy, které ještě nemají REPROCESS_MARKER_FIELD – typicky
 * čerstvě přibylé od posledního běhu. "vse" (přes menší odkaz s
 * potvrzením) ignoruje marker a přepočítá úplně všechny aktuální zprávy od
 * nuly – hodí se při změně parsovací logiky, kdy i dřív už zpracované
 * zprávy potřebují nové/opravené hodnoty.
 *
 * Po přepočítání polí navíc u KAŽDÉHO dotčeného čísla zařízení (aktuálního i
 * historicky předchozího – to se řeší samo, protože sync čte fresh data
 * přímo z Firestore) spustí synchronizujHistoriiZarizeni – tím se historie
 * zkrátí na poslední 2 zprávy (starší se smažou i s PDF ve Storage) a do
 * plánu se dosadí skutečně nejnovější zpráva.
 *
 * Běh lze tlačítkem "Přerušit zpracování" bezpečně zastavit – dokončí se
 * soubor, který se právě zpracovává (jedna "skupina", viz processGroup),
 * ale nezačne se další. Průběh (ID už hotových zpráv) se přitom průběžně
 * ukládá do localStorage (viz ReprocessCheckpoint) – při příštím spuštění
 * appka nabídne pokračovat jen se zbývajícími, místo aby začínala od nuly.
 */
function RevizniZpravyReprocess() {
  const [status, setStatus] = useState<"idle" | "processing" | "done" | "prerusene">("idle");
  // Který ze dvou režimů (viz ReprocessMod) právě běží/naposledy doběhl –
  // jen pro popisky v UI (progress text, souhrn), na volbu dávky uvnitř
  // handleReprocess nemá vliv (ten dostane režim přímo jako argument).
  const [bezicíRezim, setBezicíRezim] = useState<ReprocessMod>("nove");
  // Nastavuje se kliknutím na "Přerušit zpracování". Čte se z ref, ne ze
  // state – zajímá o ni běžící smyčka uvnitř handleReprocess (viz worker
  // níž), a ref na rozdíl od state dá vždycky aktuální hodnotu i uvnitř už
  // rozběhnutého closure bez čekání na překreslení.
  const prerusitRef = useRef(false);
  const [zadanoPreruseni, setZadanoPreruseni] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  // Jen posledních RESULTS_DISPLAY_LIMIT položek (viz komentář u konstanty) –
  // pro souhrnné počty (kolik OK/NOK/chyb apod.) slouží souhrnVysledku níž.
  const [results, setResults] = useState<ReprocessResult[]>([]);
  const [souhrnVysledku, setSouhrnVysledku] = useState<VysledkySouhrn>(PRAZDNY_VYSLEDKY_SOUHRN);
  const [error, setError] = useState("");
  const [pruneSouhrn, setPruneSouhrn] = useState<PruneSouhrn | null>(null);
  const [pruneProgress, setPruneProgress] = useState({ done: 0, total: 0 });
  // Kolik zpráv by teď zpracovalo výchozí (jen "nové") tlačítko, a kolik by
  // jich zpracovalo úplné přezpracování všeho – null = ještě se nezjistilo
  // (počáteční načítání) nebo se zjistit nepodařilo.
  const [pocetNove, setPocetNove] = useState<number | null>(null);
  const [pocetVse, setPocetVse] = useState<number | null>(null);
  const [pocetChyba, setPocetChyba] = useState("");
  // Zachyceno při zamountování téhle komponenty – jestli tou dobou už
  // bezicíZpracovani něco drželo, znamená to, že zpracování spustila dřívější
  // (teď odmountovaná) instance téhle komponenty a stále běží na pozadí.
  const [zablokovanoJinde] = useState<{ rezim: ReprocessMod; zacatek: Date } | null>(
    () => bezicíZpracovani
  );
  // Nedokončený checkpoint z předchozího (přerušeného, nebo nikdy
  // nedoběhlého) běhu – zjišťuje se/aktualizuje v nacistPocty spolu s
  // počty, ať zbývající počet vždycky odpovídá aktuálním datům (viz
  // "zbyva" – i mezitím přibylé nové zprávy se do něj započítají).
  const [checkpoint, setCheckpoint] = useState<(ReprocessCheckpoint & { zbyva: number }) | null>(
    null
  );

  const nacistPocty = async () => {
    try {
      const snap = await getDocs(collection(db, "revizni_zpravy"));
      const aktualni = vyberAktualniZpravy(snap.docs);
      const nove = aktualni.filter((d) => !jeZpracovanoReprocessem(d));
      setPocetVse(aktualni.length);
      setPocetNove(nove.length);

      const cp = nacistReprocessCheckpoint();
      if (cp) {
        const cilova = cp.mod === "vse" ? aktualni : nove;
        const hotoveSet = new Set(cp.hotoveIds);
        const zbyva = cilova.filter((d) => !hotoveSet.has(d.id)).length;
        if (zbyva > 0) {
          setCheckpoint({ ...cp, zbyva });
        } else {
          // Poslední zbývající zprávy mezitím zpracoval/smazal někdo jiný
          // (jiná karta, jiný běh) – checkpoint je tak fakticky hotový.
          smazatReprocessCheckpoint();
          setCheckpoint(null);
        }
      } else {
        setCheckpoint(null);
      }

      setPocetChyba("");
    } catch (err) {
      setPocetChyba(
        err instanceof Error ? err.message : "Nepodařilo se zjistit počet zpráv ke zpracování."
      );
    }
  };

  // Zjištění počtů se stejnou logikou (vyberAktualniZpravy +
  // jeZpracovanoReprocessem), jakou pak použije samotné zpracování – ať
  // čísla u tlačítek sedí s tím, co appka po kliknutí skutečně zpracuje.
  useEffect(() => {
    nacistPocty();
  }, []);

  const handleReprocess = async (mod: ReprocessMod, moznosti?: { pokracovat?: boolean }) => {
    if (bezicíZpracovani) {
      setError(
        "Zpracování už běží (spuštěné odjinud – jinou kartou/oknem, nebo dřívější návštěvou téhle stránky). Počkej, až doběhne, případně načti stránku znovu."
      );
      return;
    }

    const existujiciCheckpoint = moznosti?.pokracovat ? nacistReprocessCheckpoint() : null;
    // Pokračování dává smysl jen se stejným režimem, jaký checkpoint měl -
    // jinak (nebo když se nepokračuje) se prostě začíná s prázdným setem
    // hotových ID, jako dřív.
    const hotoveIdsRunning = new Set<string>(
      existujiciCheckpoint && existujiciCheckpoint.mod === mod ? existujiciCheckpoint.hotoveIds : []
    );

    prerusitRef.current = false;
    setZadanoPreruseni(false);
    setStatus("processing");
    setBezicíRezim(mod);
    setResults([]);
    setSouhrnVysledku(PRAZDNY_VYSLEDKY_SOUHRN);
    setError("");
    setPruneSouhrn(null);
    setProgress({ done: 0, total: 0 });
    setPruneProgress({ done: 0, total: 0 });

    bezicíZpracovani = { rezim: mod, zacatek: new Date() };
    try {
      const snap = await getDocs(collection(db, "revizni_zpravy"));
      const aktualni = vyberAktualniZpravy(snap.docs);
      const cilova = mod === "vse" ? aktualni : aktualni.filter((d) => !jeZpracovanoReprocessem(d));
      // Zbývající = cílová dávka MINUS to, co už (i z dřívějšího přerušeného
      // běhu) hotové je – tím se do fronty samy započítají i mezitím
      // přibylé nové zprávy, aniž by se znovu řešilo už hotové.
      let docs: QueryDocumentSnapshot<DocumentData>[] = cilova.filter(
        (d) => !hotoveIdsRunning.has(d.id)
      );
      // Zapamatováno zvlášť (ne docs.length dole v reportDoc), ať appka
      // nemusí kvůli jednomu číslu dál držet referenci na celé pole docs.
      const totalDocs = docs.length;
      setProgress({ done: 0, total: totalDocs });

      // Skupina podle pdf_storage_path – víc revizních zpráv (stránek) může
      // odkazovat na stejný nahraný soubor, ať se nestahuje víckrát.
      const groups = new Map<string, QueryDocumentSnapshot<DocumentData>[]>();
      for (const d of docs) {
        const path = d.data().pdf_storage_path;
        if (typeof path !== "string") continue;
        const group = groups.get(path) ?? [];
        group.push(d);
        groups.set(path, group);
      }
      // docs appka dál nepotřebuje (jen k sestavení groups výš) – uvolní ho
      // z paměti, ať zbytek běhu drží zbývající zprávy jen jednou, v
      // groupBatches níž.
      docs = [];

      let done = 0;
      const dotcenaZarizeni = new Set<string>();
      const reportDoc = (result: ReprocessResult) => {
        done += 1;
        setProgress({ done, total: totalDocs });
        if (result.cislo_zarizeni) dotcenaZarizeni.add(result.cislo_zarizeni);

        // Tabulka drží jen posledních RESULTS_DISPLAY_LIMIT položek (slice
        // je i tak O(limit), ne O(celkový počet)) – u dávek v tisících jinak
        // appka při každé další položce kopírovala/vykreslovala pořád delší
        // pole, což dokázalo prohlížeč na dlouho zaseknout.
        setResults((prev) => [...prev, result].slice(-RESULTS_DISPLAY_LIMIT));

        // Souhrnné počty se aktualizují přírůstkově (O(1) na položku), ne
        // filtrováním celého pole výsledků při každém překreslení.
        setSouhrnVysledku((prev) => ({
          zpracovano: prev.zpracovano + 1,
          uspesne: prev.uspesne + (result.stav !== "chyba" ? 1 : 0),
          chyba: prev.chyba + (result.stav === "chyba" ? 1 : 0),
          ok: prev.ok + (result.vysledekRevize === "OK" ? 1 : 0),
          nok: prev.nok + (result.vysledekRevize === "NOK" ? 1 : 0),
          keKontrole: prev.keKontrole + (result.vysledekRevize === "KE_KONTROLE" ? 1 : 0),
          keKontroleZarizeni:
            result.vysledekRevize === "KE_KONTROLE" &&
            prev.keKontroleZarizeni.length < KE_KONTROLE_LIST_LIMIT
              ? [...prev.keKontroleZarizeni, result.cislo_zarizeni]
              : prev.keKontroleZarizeni,
        }));
      };

      const processGroup = async ([storagePath, groupDocs]: [
        string,
        QueryDocumentSnapshot<DocumentData>[],
      ]) => {
        // Malá náhodná prodleva před každým stažením – rozloží špičky, kdy
        // by jinak DOWNLOAD_CONCURRENCY workerů startovalo stahování ve
        // stejném okamžiku (typický spouštěč "storage/retry-limit-exceeded"
        // při dávkách desítek souborů za sebou).
        await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));

        let freshByStranka: Map<number, ParsedRevizniZprava> | null = null;
        let downloadError = "";
        try {
          const buffer = await getBytes(ref(storage, storagePath));
          const { zpravy } = await parseRevizniZpravyPdf(buffer);
          freshByStranka = new Map(zpravy.map((z) => [z.stranka, z]));
        } catch (err) {
          downloadError =
            err instanceof Error ? err.message : "nepodařilo se stáhnout soubor ze Storage";
        }

        for (const docSnap of groupDocs) {
          const data = docSnap.data();
          const soubor = typeof data.soubor_nazev === "string" ? data.soubor_nazev : storagePath;
          const stranka = typeof data.stranka === "number" ? data.stranka : 0;
          const cisloPuvodni = typeof data.cislo_zarizeni === "string" ? data.cislo_zarizeni : "";

          const fresh = freshByStranka?.get(stranka);

          if (downloadError) {
            reportDoc({
              id: docSnap.id,
              soubor,
              stranka,
              cislo_zarizeni: cisloPuvodni,
              stav: "chyba",
              poznamka: downloadError,
            });
          } else if (!fresh) {
            reportDoc({
              id: docSnap.id,
              soubor,
              stranka,
              cislo_zarizeni: cisloPuvodni,
              stav: "chyba",
              poznamka: "stránka se po přeparsování nepodařila znovu rozpoznat",
            });
          } else if (fresh.cislo_zarizeni !== cisloPuvodni) {
            reportDoc({
              id: docSnap.id,
              soubor,
              stranka,
              cislo_zarizeni: cisloPuvodni,
              stav: "chyba",
              poznamka: `číslo zařízení se po přeparsování změnilo (${cisloPuvodni} → ${fresh.cislo_zarizeni}) – přeskočeno`,
            });
          } else {
            try {
              await updateDoc(docSnap.ref, {
                ...revizniZpravaToFirestoreFields(fresh),
                [REPROCESS_MARKER_FIELD]: Timestamp.fromDate(new Date()),
              });

              // Checkpoint se ukládá průběžně po KAŽDÉ úspěšně zpracované
              // zprávě (ne až na konci) – ať přerušení/pád prohlížeče
              // uprostřed běhu neztratí rozdělanou práci.
              hotoveIdsRunning.add(docSnap.id);
              ulozitReprocessCheckpoint({
                mod,
                hotoveIds: Array.from(hotoveIdsRunning),
                aktualizovano: new Date().toISOString(),
              });

              // Dosazení do plánu (a případné prořezání starší historie) se
              // řeší až po přepočítání úplně všech zpráv, viz
              // synchronizujHistoriiZarizeni níž – ne tady za každou zprávu
              // zvlášť, ať pořadí zpracování skupin neovlivní výsledek.
              reportDoc({
                id: docSnap.id,
                soubor,
                stranka,
                cislo_zarizeni: fresh.cislo_zarizeni,
                stav: "aktualizovano",
                poznamka: "",
                vysledekRevize: fresh.vysledek_revize,
              });
            } catch (err) {
              reportDoc({
                id: docSnap.id,
                soubor,
                stranka,
                cislo_zarizeni: cisloPuvodni,
                stav: "chyba",
                poznamka: err instanceof Error ? err.message : "nepodařilo se zapsat do Firestore",
              });
            }
          }
        }
      };

      // Skupiny (soubory) zpracováváme s omezenou souběžností – při stovkách
      // uložených zpráv by čistě sekvenční zpracování trvalo příliš dlouho,
      // ale neomezená souběžnost by zase zbytečně zatížila Storage (zdroj
      // "storage/retry-limit-exceeded" chyb při dávkách desítek souborů) –
      // proto jen 4 souběžná stahování + malá náhodná prodleva výš v
      // processGroup, ať appka nepálí požadavky na Storage v jedné špičce.
      const DOWNLOAD_CONCURRENCY = 4;
      // Skupiny appka nezpracovává všechny najednou jedním worker poolem,
      // ale po dávkách max. REPROCESS_BATCH_SIZE (viz komentář u konstanty) –
      // groups appka dál nepotřebuje (rozdělena do groupBatches), ať v
      // paměti nezůstává i po chunk() ještě jednou navíc.
      const groupBatches = chunk(Array.from(groups.entries()), REPROCESS_BATCH_SIZE);
      groups.clear();

      for (let batchIndex = 0; batchIndex < groupBatches.length; batchIndex += 1) {
        if (prerusitRef.current) break;
        const batchEntries = groupBatches[batchIndex];
        let nextIndex = 0;
        async function worker() {
          while (nextIndex < batchEntries.length) {
            // Kontrola AŽ TADY (ne uprostřed processGroup) – rozdělaný soubor,
            // který se právě stahuje/parsuje/zapisuje, se dokončí celý, jen se
            // nezačne další. Nejde tak vzniknout napůl zapsaný záznam.
            if (prerusitRef.current) break;
            const entry = batchEntries[nextIndex];
            nextIndex += 1;
            await processGroup(entry);
            // Vrátí řízení hlavnímu vláknu PO KAŽDÉM zpracovaném souboru (ne
            // jen jednou za celou dávku 50/100) – i když processGroup čeká na
            // síťová volání (Storage/Firestore), řetězec navazujících await
            // pokračování (mikrotasky) se bez týhle explicitní hranice může
            // provést dost dlouho v kuse bez jediné šance na vykreslení
            // snímku nebo zpracování uživatelského vstupu. Tohle (ne pauza
            // mezi dávkami) je hlavní obrana proti "Stránka nereaguje".
            await yieldToMainThread();
          }
        }
        await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, () => worker()));

        // Dokončenou dávku appka z pole hned uvolní (ne až po doběhnutí
        // úplně celého zpracování) – u front v řádu tisíců souborů tak v
        // paměti drží jen tu dávku, která se zrovna zpracovává/čeká, ne
        // odkazy na úplně všechno najednou.
        groupBatches[batchIndex] = [];

        const jePosledniDavka = batchIndex === groupBatches.length - 1;
        if (!prerusitRef.current && !jePosledniDavka) {
          // Krátká pauza mezi dávkami – dá prohlížeči prostor uvolněnou
          // paměť z dávky výš skutečně sklidit (garbage collection), než
          // appka spustí další. Uživatel mezi dávkami nic neklikal ani
          // neuvidí přerušení – zpracování pokračuje samo automaticky.
          await new Promise((resolve) => setTimeout(resolve, REPROCESS_BATCH_PAUSE_MS));
        }
      }
      const prerušeno = prerusitRef.current;

      // Prořezání historie (starší než poslední 2 podle data provedení pryč,
      // včetně PDF ve Storage) a dosazení skutečně nejnovější zprávy do
      // plánu – za KAŽDÉ dotčené číslo zařízení, ne jen za ty, co se v tomhle
      // běhu podařilo znovu naparsovat. Tohle je i jednorázové prořezání dat
      // uložených předtím, než appka historii začala omezovat.
      const zarizeniList = Array.from(dotcenaZarizeni);
      setPruneProgress({ done: 0, total: zarizeniList.length });
      const planSynchronizovanoByZarizeni = new Map<string, boolean>();
      let pruneDone = 0;
      const souhrn: PruneSouhrn = {
        zarizeni: zarizeniList.length,
        zarizeniSMazanim: 0,
        smazanoZaznamu: 0,
        smazanoSouboru: 0,
      };
      // Čistě Firestore operace (bez stahování ze Storage) – souběžnost
      // nemusí být tak opatrná jako u stahování PDF výš.
      const PRUNE_CONCURRENCY = 6;
      let nextPruneIndex = 0;
      async function pruneWorker() {
        while (nextPruneIndex < zarizeniList.length) {
          const cislo = zarizeniList[nextPruneIndex];
          nextPruneIndex += 1;
          const vysledek = await synchronizujHistoriiZarizeni(cislo);
          if (vysledek.smazanoZaznamu > 0) souhrn.zarizeniSMazanim += 1;
          souhrn.smazanoZaznamu += vysledek.smazanoZaznamu;
          souhrn.smazanoSouboru += vysledek.smazanoSouboru;
          planSynchronizovanoByZarizeni.set(cislo, vysledek.planSynchronizovan);
          pruneDone += 1;
          setPruneProgress({ done: pruneDone, total: zarizeniList.length });
          // Stejný důvod jako u worker() výš – i tahle fáze prochází celý
          // zbylý seznam zařízení (klidně přes tisíc) v jednom kuse bez
          // dávkování, takže potřebuje vlastní pravidelnou hranici pro
          // vykreslení/uživatelský vstup.
          await yieldToMainThread();
        }
      }
      await Promise.all(Array.from({ length: PRUNE_CONCURRENCY }, () => pruneWorker()));

      setResults((prev) =>
        prev.map((r) =>
          r.stav === "aktualizovano" && planSynchronizovanoByZarizeni.get(r.cislo_zarizeni)
            ? { ...r, stav: "aktualizovano_i_v_planu" }
            : r
        )
      );
      setPruneSouhrn(souhrn);

      if (prerušeno) {
        // Checkpoint se NEMAŽE – zůstává, aby příští kliknutí na tlačítko
        // pokračovalo přesně od zbývajících záznamů.
        setStatus("prerusene");
      } else {
        smazatReprocessCheckpoint();
        setStatus("done");
      }
      // Prořezání (a případné mezitím nahrané nové zprávy, nebo přerušení)
      // mohlo počet aktuálních/zbývajících zpráv změnit – ať čísla u
      // tlačítek po doběhnutí sedí.
      await nacistPocty();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Nepodařilo se načíst uložené revizní zprávy."
      );
      setStatus("idle");
      // Checkpoint z toho, co se stihlo zpracovat před chybou, zůstává (viz
      // ukládání v úspěšné větvi processGroup) – ať zjištěný počet
      // zbývajících sedí, i když tenhle běh skončil chybou uprostřed.
      await nacistPocty();
    } finally {
      bezicíZpracovani = null;
    }
  };


  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-sm">
      <div className="bg-navy px-[18px] py-2.5 text-[13px] font-bold text-white">
        Znovu zpracovat uložené revizní zprávy
      </div>
      <div className="flex flex-col gap-4 px-[18px] py-5">
        <p className="text-[12.5px] text-gray-500">
          Znovu stáhne a naparsuje PDF, která appka už má uložená ve Firebase Storage (podle
          kolekce <code className="rounded bg-gray-100 px-1 py-0.5">revizni_zpravy</code>), a
          přepíše jimi extrahovaná pole – bez toho, aby bylo potřeba soubory znovu ručně vybírat
          na disku. Použij tohle tlačítko vždycky, když appka začne umět vytáhnout z revizní
          zprávy další údaj (nebo se opraví parsování existujícího), ať se dřív nahrané zprávy
          doplní/opraví automaticky. U každého zařízení se přeparsuje jen AKTUÁLNÍ (nejnovější)
          zpráva – ta předchozí zůstává v appce dál viditelná (šedý odznak), jen se zbytečně znovu
          nestahuje. Zároveň u každého čísla zařízení zkrátí historii na poslední 2 revizní zprávy
          (podle data provedení) – starší smaže i s PDF ve Storage. Výchozí tlačítko zpracuje jen
          zprávy, které tudy ještě neprošly (typicky nově přibylé) – pro přepočítání úplně všeho
          (např. po změně parsovací logiky) použij odkaz níž.
        </p>

        {zablokovanoJinde && (
          <p className="rounded-md border border-status-warn bg-orange-50 px-3 py-2 text-[12.5px] text-status-warn">
            Zpracování ({zablokovanoJinde.rezim === "vse" ? "úplně vše" : "jen nové"}, spuštěno{" "}
            {zablokovanoJinde.zacatek.toLocaleTimeString("cs-CZ")}) už běží z dřívějšího otevření
            téhle stránky a stále pokračuje na pozadí – jen se tu teď neukazuje průběh. Vyčkej,
            nebo stránku načti znovu (F5), ať zjistíš aktuální stav.
          </p>
        )}

        {status === "processing" && (
          <p className="rounded-md border border-status-warn bg-orange-50 px-3 py-2 text-[12.5px] text-status-warn">
            Nezavírej tuhle kartu prohlížeče, dokud zpracování neskončí – zavřením karty (nebo
            prohlížeče) se přeruší. Přechod na jinou stránku UVNITŘ appky zpracování nezastaví
            (běží dál na pozadí), ale dokud se nevrátíš zpět na tuhle stránku, neuvidíš průběh.
          </p>
        )}

        {checkpoint && status !== "processing" ? (
          <div className="flex flex-col items-start gap-2">
            <div className="rounded-md border border-status-warn bg-orange-50 px-3 py-2 text-[12.5px] text-status-warn">
              Nedokončený běh (režim {checkpoint.mod === "vse" ? "úplně vše" : "jen nové"}),
              naposledy aktualizován {new Date(checkpoint.aktualizovano).toLocaleString("cs-CZ")} –
              zbývá {checkpoint.zbyva} zpráv.
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => handleReprocess(checkpoint.mod, { pokracovat: true })}
                disabled={zablokovanoJinde !== null}
                className="rounded-md bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Pokračovat ve zpracování (zbývá {checkpoint.zbyva})
              </button>
              <button
                onClick={() => {
                  smazatReprocessCheckpoint();
                  setCheckpoint(null);
                }}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-[12px] font-semibold text-gray-500 transition-colors hover:bg-gray-50"
              >
                Začít znovu od začátku
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => handleReprocess("nove")}
                disabled={status === "processing" || zablokovanoJinde !== null}
                className="rounded-md bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {status === "processing" && bezicíRezim === "nove" && pruneProgress.total > 0
                  ? `Prořezávám historii… (${pruneProgress.done}/${pruneProgress.total} zařízení)`
                  : status === "processing" && bezicíRezim === "nove"
                    ? `Zpracovávám… (${progress.done}/${progress.total})`
                    : pocetNove !== null
                      ? `Zpracovat ${pocetNove} uložených revizních zpráv`
                      : "Znovu zpracovat uložené revizní zprávy"}
              </button>

              <button
                onClick={() => {
                  if (
                    window.confirm(
                      `Opravdu přepočítat úplně všech ${pocetVse ?? "?"} aktuálních revizních zpráv od nuly? ` +
                        "Tohle je silnější a pomalejší akce než běžné doplnění nových - použij ji hlavně po změně parsovací logiky."
                    )
                  ) {
                    handleReprocess("vse");
                  }
                }}
                disabled={status === "processing" || zablokovanoJinde !== null || pocetVse === null}
                title="Ignoruje, které zprávy už byly zpracované, a přepočítá úplně všechny."
                className="rounded-md border border-gray-300 px-3 py-1.5 text-[12px] font-semibold text-gray-500 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {status === "processing" && bezicíRezim === "vse" && pruneProgress.total > 0
                  ? `Prořezávám historii… (${pruneProgress.done}/${pruneProgress.total} zařízení)`
                  : status === "processing" && bezicíRezim === "vse"
                    ? `Zpracovávám vše… (${progress.done}/${progress.total})`
                    : `Zpracovat znovu úplně vše (${pocetVse ?? "…"})`}
              </button>

              {status === "processing" && (
                <button
                  onClick={() => {
                    prerusitRef.current = true;
                    setZadanoPreruseni(true);
                  }}
                  disabled={zadanoPreruseni}
                  className="rounded-md border border-status-overdue px-3 py-1.5 text-[12px] font-semibold text-status-overdue transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {zadanoPreruseni ? "Přerušuji… (dokončuji rozdělaný soubor)" : "Přerušit zpracování"}
                </button>
              )}
            </div>

            {status !== "processing" &&
              (pocetChyba ? (
                <p className="text-[11px] text-red-500">{pocetChyba}</p>
              ) : (
                <p className="text-[11px] text-gray-400">
                  {pocetNove !== null
                    ? `Ke zpracování: ${pocetNove} nových/dosud nezpracovaných revizních zpráv (z ${pocetVse} aktuálních celkem).`
                    : "Zjišťuji počet zpráv ke zpracování…"}
                </p>
              ))}
          </div>
        )}

        {error && <p className="text-[12.5px] text-red-600">{error}</p>}

        {(status === "done" || status === "prerusene") && (
          <>
            {status === "prerusene" ? (
              <div className="rounded-md border border-status-warn bg-orange-50 px-3 py-2 text-[12.5px] font-semibold text-status-warn">
                Přerušeno – zpracováno {progress.done} z {progress.total}{" "}
                {bezicíRezim === "vse" ? "aktuálních" : "nových/dosud nezpracovaných"} revizních
                zpráv ({souhrnVysledku.uspesne} úspěšně
                {souhrnVysledku.chyba > 0 ? `, ${souhrnVysledku.chyba} selhalo` : ""}). Zbytek
                zůstal uložený jako rozdělaná dávka – pokračuj tlačítkem výš.
              </div>
            ) : (
              <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-[12.5px] text-blue-700">
                Zpracováno {souhrnVysledku.zpracovano}{" "}
                {bezicíRezim === "vse" ? "aktuálních" : "nových/dosud nezpracovaných"} revizních
                zpráv: {souhrnVysledku.uspesne} úspěšně aktualizováno
                {souhrnVysledku.chyba > 0 && `, ${souhrnVysledku.chyba} selhalo`}.
              </div>
            )}

            {pruneSouhrn && (
              <div className="rounded-md border border-green-100 bg-green-50 px-3 py-2 text-[12.5px] text-status-ok">
                Prořezání historie: zkontrolováno {pruneSouhrn.zarizeni} čísel zařízení, u{" "}
                {pruneSouhrn.zarizeniSMazanim} z nich se mazalo. Smazáno celkem{" "}
                {pruneSouhrn.smazanoZaznamu} starších záznamů v „revizni_zpravy“ a{" "}
                {pruneSouhrn.smazanoSouboru} PDF souborů ve Storage.
              </div>
            )}

            {souhrnVysledku.uspesne > 0 && (
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-[12.5px] text-gray-700">
                Výsledek revize (z {souhrnVysledku.uspesne} úspěšně přepočítaných):{" "}
                {souhrnVysledku.ok} OK, {souhrnVysledku.nok} NOK, {souhrnVysledku.keKontrole} ke
                kontrole (nerozpoznaná formulace pole „Celkové hodnocení“).
                {souhrnVysledku.keKontroleZarizeni.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer font-semibold text-status-warn">
                      Čísla zařízení ke kontrole (ukázka)
                    </summary>
                    <ul className="mt-1 list-inside list-disc">
                      {souhrnVysledku.keKontroleZarizeni.map((cislo, i) => (
                        <li key={i}>{cislo || "(bez čísla zařízení)"}</li>
                      ))}
                    </ul>
                    {souhrnVysledku.keKontrole > souhrnVysledku.keKontroleZarizeni.length && (
                      <p className="mt-1 text-[11px] text-gray-400">
                        Zobrazeno prvních {souhrnVysledku.keKontroleZarizeni.length} z{" "}
                        {souhrnVysledku.keKontrole}.
                      </p>
                    )}
                  </details>
                )}
              </div>
            )}

            {results.length > 0 && (
              <div className="overflow-x-auto">
                {souhrnVysledku.zpracovano > results.length && (
                  <p className="mb-1 text-[11px] text-gray-400">
                    Zobrazeno posledních {results.length} z {souhrnVysledku.zpracovano}{" "}
                    zpracovaných – souhrnné počty výš ale zahrnují úplně všechno.
                  </p>
                )}
                <table className="w-full text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500">
                      <th className="py-1.5 pr-4 font-semibold">Soubor</th>
                      <th className="py-1.5 pr-4 font-semibold">Strana</th>
                      <th className="py-1.5 pr-4 font-semibold">Číslo zařízení</th>
                      <th className="py-1.5 pr-4 font-semibold">Výsledek</th>
                      <th className="py-1.5 pr-4 font-semibold">Výsledek revize</th>
                      <th className="py-1.5 pr-4 font-semibold">Poznámka</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => (
                      <tr key={r.id} className="border-b border-gray-100">
                        <td className="py-1.5 pr-4">{r.soubor}</td>
                        <td className="py-1.5 pr-4">{r.stranka}</td>
                        <td className="py-1.5 pr-4">{r.cislo_zarizeni}</td>
                        <td className={`py-1.5 pr-4 font-semibold ${REPROCESS_STAV_LABELS[r.stav].className}`}>
                          {REPROCESS_STAV_LABELS[r.stav].label}
                        </td>
                        <td
                          className={`py-1.5 pr-4 font-semibold ${
                            r.vysledekRevize ? VYSLEDEK_REVIZE_LABELS[r.vysledekRevize].className : ""
                          }`}
                        >
                          {r.vysledekRevize ? VYSLEDEK_REVIZE_LABELS[r.vysledekRevize].label : "—"}
                        </td>
                        <td className="py-1.5 pr-4 text-gray-500">{r.poznamka || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function NahratPage() {
  return (
    <AuthGate>
      {(user) => (
        <div className="flex min-h-full flex-1 flex-col bg-[#eef1f5]">
          <AppHeader user={user} />
          <AppNav />

          <div className="flex flex-col gap-4 px-7 py-6">
            <PlanUpload />
            <RevizniZpravyUpload />
            <RevizniZpravyReprocess />
          </div>
        </div>
      )}
    </AuthGate>
  );
}
