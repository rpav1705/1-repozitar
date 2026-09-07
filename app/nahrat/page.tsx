"use client";

import { useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";
import { db } from "@/lib/firebase";
import { collection, doc, writeBatch, Timestamp } from "firebase/firestore";
import { parsePlanWorkbook, ParsedPlanRow, ParseSkip } from "@/lib/xlsxImport";
import { describeSaveError } from "@/lib/friendlyError";

function PlanUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ParsedPlanRow[]>([]);
  const [skipped, setSkipped] = useState<ParseSkip[]>([]);
  const [status, setStatus] = useState<"idle" | "parsing" | "parsed" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

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
    try {
      const batch = writeBatch(db);
      const col = collection(db, "planovane_revize");
      rows.forEach((row) => {
        const ref = doc(col);
        batch.set(ref, {
          cislo_zarizeni: row.cislo_zarizeni,
          popis: row.popis,
          termin: Timestamp.fromDate(row.termin),
          frekvence: row.frekvence,
          jednotky_frekvence: row.jednotky_frekvence,
          stav: "cekajici",
        });
      });
      await batch.commit();
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
          <code className="rounded bg-gray-100 px-1 py-0.5">cekajici</code>.
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
            Ukládám záznamy do databáze…
          </p>
        )}

        {status === "error" && error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-600">{error}</p>
        )}

        {(status === "parsed" || status === "saving" || status === "saved") && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-[12.5px] text-blue-700">
              <span>
                Nalezeno {rows.length} platných záznamů{" "}
                {skipped.length > 0 && `(přeskočeno ${skipped.length})`}.
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
                        <td className="py-1.5 pr-4">{row.termin.toLocaleDateString("cs-CZ")}</td>
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

export default function NahratPage() {
  return (
    <AuthGate>
      {(user) => (
        <div className="flex min-h-full flex-1 flex-col bg-[#eef1f5]">
          <AppHeader user={user} />
          <AppNav />

          <div className="flex flex-col gap-4 px-7 py-6">
            <PlanUpload />
          </div>
        </div>
      )}
    </AuthGate>
  );
}
