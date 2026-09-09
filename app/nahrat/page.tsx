"use client";

import { useEffect, useState } from "react";
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
import { parseRevizniZpravyPdf, ParsedRevizniZprava } from "@/lib/pdfRevizniZprava";
import { revizniZpravaToFirestoreFields } from "@/lib/revizniZpravyFirestore";
import { synchronizujHistoriiZarizeni } from "@/lib/revizniZpravyHistorie";
import { describeSaveError } from "@/lib/friendlyError";

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

function PlanUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ParsedPlanRow[]>([]);
  const [skipped, setSkipped] = useState<ParseSkip[]>([]);
  const [status, setStatus] = useState<"idle" | "parsing" | "parsed" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [savedCount, setSavedCount] = useState(0);

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
          a ručně doplnit.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".xls,.xlsx"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setRows([]);
              setSkipped([]);
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
                Nalezeno {rows.length} záznamů: {rows.length - missingTerminCount} v pořádku
                {missingTerminCount > 0 &&
                  `, ${missingTerminCount} bez termínu (budou uloženy, ale je potřeba je ručně doplnit)`}
                {skipped.length > 0 && ` — přeskočeno ${skipped.length} prázdných řádků`}.
              </span>
              {status !== "saved" && (
                <button
                  onClick={handleSave}
                  disabled={rows.length === 0 || status === "saving"}
                  className="rounded-md bg-accent px-4 py-1.5 text-[12.5px] font-bold tracking-wide text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === "saving" ? "Ukládám…" : `Uložit ${rows.length} záznamů`}
                </button>
              )}
            </div>

            {status === "saved" && (
              <p className="rounded-md bg-green-50 px-3 py-2 text-[12.5px] font-semibold text-status-ok">
                Úspěšně uloženo {rows.length} záznamů do databáze (planovane_revize).
              </p>
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
};

const REPROCESS_STAV_LABELS: Record<ReprocessStav, { label: string; className: string }> = {
  aktualizovano: { label: "Aktualizováno", className: "text-status-ok" },
  aktualizovano_i_v_planu: { label: "Aktualizováno i v plánu", className: "text-status-ok" },
  chyba: { label: "Selhalo", className: "text-status-overdue" },
};

type PruneSouhrn = {
  zarizeni: number;
  zarizeniSMazanim: number;
  smazanoZaznamu: number;
  smazanoSouboru: number;
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
 * Po přepočítání polí navíc u KAŽDÉHO dotčeného čísla zařízení (aktuálního i
 * historicky předchozího – to se řeší samo, protože sync čte fresh data
 * přímo z Firestore) spustí synchronizujHistoriiZarizeni – tím se historie
 * zkrátí na poslední 2 zprávy (starší se smažou i s PDF ve Storage) a do
 * plánu se dosadí skutečně nejnovější zpráva. Tohle tlačítko tak zároveň
 * slouží jako jednorázové prořezání i pro zprávy uložené předtím, než appka
 * historii omezovat začala.
 */
function RevizniZpravyReprocess() {
  const [status, setStatus] = useState<"idle" | "processing" | "done">("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<ReprocessResult[]>([]);
  const [error, setError] = useState("");
  const [pruneSouhrn, setPruneSouhrn] = useState<PruneSouhrn | null>(null);
  const [pruneProgress, setPruneProgress] = useState({ done: 0, total: 0 });
  // Kolik zpráv by teď tlačítko zpracovalo – null = ještě se nezjistilo
  // (počáteční načítání) nebo se zjistit nepodařilo.
  const [pocetKeZpracovani, setPocetKeZpracovani] = useState<number | null>(null);
  const [pocetChyba, setPocetChyba] = useState("");

  const nacistPocetKeZpracovani = async () => {
    try {
      const snap = await getDocs(collection(db, "revizni_zpravy"));
      setPocetKeZpracovani(vyberAktualniZpravy(snap.docs).length);
      setPocetChyba("");
    } catch (err) {
      setPocetChyba(
        err instanceof Error ? err.message : "Nepodařilo se zjistit počet zpráv ke zpracování."
      );
    }
  };

  // Zjištění počtu se stejnou logikou (vyberAktualniZpravy), jakou pak
  // použije samotné zpracování – ať se číslo u tlačítka shoduje s tím, co
  // appka po kliknutí skutečně stáhne a naparsuje.
  useEffect(() => {
    nacistPocetKeZpracovani();
  }, []);

  const handleReprocess = async () => {
    setStatus("processing");
    setResults([]);
    setError("");
    setPruneSouhrn(null);
    setProgress({ done: 0, total: 0 });
    setPruneProgress({ done: 0, total: 0 });

    try {
      const snap = await getDocs(collection(db, "revizni_zpravy"));
      const docs = vyberAktualniZpravy(snap.docs);
      setProgress({ done: 0, total: docs.length });

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

      let done = 0;
      const dotcenaZarizeni = new Set<string>();
      const reportDoc = (result: ReprocessResult) => {
        done += 1;
        setProgress({ done, total: docs.length });
        setResults((prev) => [...prev, result]);
        if (result.cislo_zarizeni) dotcenaZarizeni.add(result.cislo_zarizeni);
      };

      const processGroup = async ([storagePath, groupDocs]: [
        string,
        QueryDocumentSnapshot<DocumentData>[],
      ]) => {
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
              await updateDoc(docSnap.ref, revizniZpravaToFirestoreFields(fresh));

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
      // ale neomezená souběžnost by zase zbytečně zatížila Storage/Firestore.
      const CONCURRENCY = 6;
      const groupEntries = Array.from(groups.entries());
      let nextIndex = 0;
      async function worker() {
        while (nextIndex < groupEntries.length) {
          const entry = groupEntries[nextIndex];
          nextIndex += 1;
          await processGroup(entry);
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

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
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => pruneWorker()));

      setResults((prev) =>
        prev.map((r) =>
          r.stav === "aktualizovano" && planSynchronizovanoByZarizeni.get(r.cislo_zarizeni)
            ? { ...r, stav: "aktualizovano_i_v_planu" }
            : r
        )
      );
      setPruneSouhrn(souhrn);

      setStatus("done");
      // Prořezání (a případné mezitím nahrané nové zprávy) mohlo počet
      // aktuálních zpráv změnit – ať číslo u tlačítka po dokončení sedí.
      await nacistPocetKeZpracovani();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Nepodařilo se načíst uložené revizní zprávy."
      );
      setStatus("idle");
    }
  };

  const uspesneCount = results.filter((r) => r.stav !== "chyba").length;
  const chybaCount = results.filter((r) => r.stav === "chyba").length;

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
          (podle data provedení) – starší smaže i s PDF ve Storage.
        </p>

        <div className="flex flex-col items-start gap-1.5">
          <button
            onClick={handleReprocess}
            disabled={status === "processing"}
            className="rounded-md bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "processing" && pruneProgress.total > 0
              ? `Prořezávám historii… (${pruneProgress.done}/${pruneProgress.total} zařízení)`
              : status === "processing"
                ? `Zpracovávám… (${progress.done}/${progress.total})`
                : pocetKeZpracovani !== null
                  ? `Zpracovat ${pocetKeZpracovani} uložených revizních zpráv`
                  : "Znovu zpracovat uložené revizní zprávy"}
          </button>
          {status !== "processing" &&
            (pocetChyba ? (
              <p className="text-[11px] text-red-500">{pocetChyba}</p>
            ) : (
              <p className="text-[11px] text-gray-400">
                {pocetKeZpracovani !== null
                  ? `Ke zpracování: ${pocetKeZpracovani} revizních zpráv (jen aktuální/nejnovější u každého zařízení, starší historické se nepočítají).`
                  : "Zjišťuji počet zpráv ke zpracování…"}
              </p>
            ))}
        </div>

        {error && <p className="text-[12.5px] text-red-600">{error}</p>}

        {status === "done" && (
          <>
            <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-[12.5px] text-blue-700">
              Zpracováno {results.length} uložených revizních zpráv: {uspesneCount} úspěšně
              aktualizováno
              {chybaCount > 0 && `, ${chybaCount} selhalo`}.
            </div>

            {pruneSouhrn && (
              <div className="rounded-md border border-green-100 bg-green-50 px-3 py-2 text-[12.5px] text-status-ok">
                Prořezání historie: zkontrolováno {pruneSouhrn.zarizeni} čísel zařízení, u{" "}
                {pruneSouhrn.zarizeniSMazanim} z nich se mazalo. Smazáno celkem{" "}
                {pruneSouhrn.smazanoZaznamu} starších záznamů v „revizni_zpravy“ a{" "}
                {pruneSouhrn.smazanoSouboru} PDF souborů ve Storage.
              </div>
            )}

            {results.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500">
                      <th className="py-1.5 pr-4 font-semibold">Soubor</th>
                      <th className="py-1.5 pr-4 font-semibold">Strana</th>
                      <th className="py-1.5 pr-4 font-semibold">Číslo zařízení</th>
                      <th className="py-1.5 pr-4 font-semibold">Výsledek</th>
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
