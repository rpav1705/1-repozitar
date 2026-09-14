"use client";

import { useEffect, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  writeBatch,
} from "firebase/firestore";
import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";
import { db } from "@/lib/firebase";
import { formatLogCas } from "@/lib/formatLogCas";
import {
  CenikSouborVysledek,
  parseCenikPdf,
  ResolvenaCenikPolozka,
  SpornaCenikPolozka,
  vyresitCenikSoubory,
} from "@/lib/pdfCenik";
import { sanitizeDocId } from "@/lib/revizniZpravyFirestore";

const CENIK_COLLECTION = "cenik";
const BATCH_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Case-insensitive a na diakritice nezávislé porovnání – stejný přístup jako
// fulltextové hledání na dashboardu (viz normalizeSearchText v app/page.tsx).
function normalizeSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function formatCena(cena: number): string {
  return `${cena.toLocaleString("cs-CZ")} Kč`;
}

/**
 * Vlastní tlačítko pro výběr souboru MÍSTO nativního vzhledu prohlížeče –
 * stejný vzor jako FilePickerButton v app/nahrat/page.tsx (viz komentář tam),
 * jen zdvojený sem, ať appka nemusí kvůli jedné maličkosti sdílet komponentu
 * napříč dvěma nezávislými stránkami.
 */
function FilePickerButton({
  label,
  onChange,
  selectedText,
}: {
  label: string;
  onChange: (files: FileList | null) => void;
  selectedText: string;
}) {
  return (
    <>
      <label className="cursor-pointer rounded-md bg-navy px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-navy-dark">
        {label}
        <input
          type="file"
          accept="application/pdf"
          multiple
          onChange={(e) => onChange(e.target.files)}
          className="hidden"
        />
      </label>
      <span className="text-[13px] text-gray-500">{selectedText}</span>
    </>
  );
}

function pluralizeSoubor(count: number): string {
  if (count === 1) return "soubor";
  if (count >= 2 && count <= 4) return "soubory";
  return "souborů";
}

type UlozenaCenaExisting = {
  cena: number;
  datum_nabidky: Date | null;
};

/**
 * Nahrání jedné nebo víc cenových nabídek (PDF) a uložení do kolekce
 * "cenik" – logika výběru ceny za jedno číslo zařízení (nejnovější nabídka
 * vyhrává, sporné případy appka vůbec neuloží) je v lib/pdfCenik.ts
 * (vyresitCenikSoubory), appka tady jen parsuje soubory a zobrazuje náhled.
 */
function CenikUpload({ onUlozeno }: { onUlozeno: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<"idle" | "parsing" | "parsed" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [pripraveno, setPripraveno] = useState<ResolvenaCenikPolozka[]>([]);
  const [sporne, setSporne] = useState<SpornaCenikPolozka[]>([]);
  const [preskoceno, setPreskoceno] = useState<{ soubor: string; duvod: string }[]>([]);
  const [savedInfo, setSavedInfo] = useState<{ ulozeno: number; preskocenoStarsi: number } | null>(null);

  const handleParse = async () => {
    if (files.length === 0) return;
    setStatus("parsing");
    setError("");
    setSavedInfo(null);
    try {
      const soubory: CenikSouborVysledek[] = [];
      const chyby: { soubor: string; duvod: string }[] = [];

      for (const file of files) {
        try {
          const buffer = await file.arrayBuffer();
          const result = await parseCenikPdf(buffer);
          if (result.polozky.length === 0) {
            chyby.push({ soubor: file.name, duvod: "v souboru se nenašla žádná položka s číslem zařízení a cenou" });
            continue;
          }
          soubory.push({
            soubor: file.name,
            cislo_nabidky: result.cislo_nabidky,
            datum_nabidky: result.datum_nabidky,
            polozky: result.polozky,
          });
        } catch (err) {
          chyby.push({
            soubor: file.name,
            duvod: err instanceof Error ? err.message : "soubor se nepodařilo zpracovat kvůli neznámé chybě",
          });
        }
      }

      const { pripraveno: pripravenoVysledek, sporne: sporneVysledek } = vyresitCenikSoubory(soubory);
      setPripraveno(pripravenoVysledek);
      setSporne(sporneVysledek);
      setPreskoceno(chyby);
      setStatus("parsed");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Soubory se nepodařilo zpracovat kvůli neznámé chybě. Zkus to prosím znovu."
      );
      setStatus("error");
    }
  };

  const handleSave = async () => {
    setError("");
    setStatus("saving");
    try {
      // Existující ceny appka natáhne předem – nová cena z aktuální dávky
      // přepíše starou JEN pokud je z novější nabídky (viz komentář u
      // vyresitCenikSoubory v lib/pdfCenik.ts), ať omylem nahraná stará
      // nabídka nepřepíše mezitím už uloženou novější cenu.
      const existingSnap = await getDocs(collection(db, CENIK_COLLECTION));
      const existing = new Map<string, UlozenaCenaExisting>();
      existingSnap.docs.forEach((d) => {
        const data = d.data();
        existing.set(d.id, {
          cena: typeof data.cena === "number" ? data.cena : 0,
          datum_nabidky: data.datum_nabidky instanceof Timestamp ? data.datum_nabidky.toDate() : null,
        });
      });

      const kUlozeni = pripraveno.filter((p) => {
        const stavajici = existing.get(sanitizeDocId(p.cislo_zarizeni));
        if (!stavajici || !stavajici.datum_nabidky) return true;
        if (!p.datum_nabidky) return false;
        return p.datum_nabidky.getTime() >= stavajici.datum_nabidky.getTime();
      });
      const preskocenoStarsi = pripraveno.length - kUlozeni.length;

      const nahrano = Timestamp.fromDate(new Date());
      for (const skupina of chunk(kUlozeni, BATCH_SIZE)) {
        const batch = writeBatch(db);
        skupina.forEach((p) => {
          const id = sanitizeDocId(p.cislo_zarizeni);
          if (!id) return;
          const ref = doc(db, CENIK_COLLECTION, id);
          batch.set(ref, {
            cislo_zarizeni: p.cislo_zarizeni,
            popis: p.popis,
            cena: p.cena,
            cislo_nabidky: p.cislo_nabidky,
            datum_nabidky: p.datum_nabidky ? Timestamp.fromDate(p.datum_nabidky) : null,
            soubor_nazev: p.soubor_nazev,
            nahrano,
          });
        });
        await batch.commit();
      }

      setSavedInfo({ ulozeno: kUlozeni.length, preskocenoStarsi });
      setStatus("saved");
      onUlozeno();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uložení se nezdařilo kvůli neznámé chybě. Zkus to prosím znovu.");
      setStatus("error");
    }
  };

  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-sm">
      <div className="bg-navy px-[18px] py-2.5 text-[13px] font-bold text-white">
        Import ceníku z cenové nabídky (PDF)
      </div>
      <div className="flex flex-col gap-4 px-[18px] py-5">
        <p className="text-[12.5px] text-gray-500">
          Nahraj jednu nebo víc cenových nabídek (PDF) – appka z každé vytáhne číslo zařízení a cenu
          revize u položek, které mají v nabídce vyplněné číslo zařízení (položky bez něj appka
          přeskočí, nemá je s čím spárovat). Pokud se stejné zařízení objeví ve víc nabídkách,
          použije se cena z nejnovější z nich (podle data nabídky).
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <FilePickerButton
            label="Vybrat soubory (.pdf nabídky)"
            onChange={(fileList) => {
              setFiles(Array.from(fileList ?? []));
              setPripraveno([]);
              setSporne([]);
              setPreskoceno([]);
              setSavedInfo(null);
              setStatus("idle");
            }}
            selectedText={
              files.length > 0 ? `${files.length} ${pluralizeSoubor(files.length)} vybráno` : "Žádné soubory nevybrány"
            }
          />
          <button
            onClick={handleParse}
            disabled={files.length === 0 || status === "parsing"}
            className="rounded-md bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "parsing" ? "Zpracovávám…" : "Zpracovat soubory"}
          </button>
        </div>

        {status === "error" && error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-600">{error}</p>
        )}

        {preskoceno.length > 0 && (
          <details className="text-[12px] text-gray-500">
            <summary className="cursor-pointer font-semibold text-status-warn">
              Nezpracované soubory ({preskoceno.length})
            </summary>
            <ul className="mt-1 list-inside list-disc">
              {preskoceno.map((s, i) => (
                <li key={i}>
                  {s.soubor}: {s.duvod}
                </li>
              ))}
            </ul>
          </details>
        )}

        {(status === "parsed" || status === "saving" || status === "saved") && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-[12.5px] text-blue-700">
              <span>
                Rozpoznáno {pripraveno.length + sporne.length} čísel zařízení: {pripraveno.length} připraveno k
                uložení
                {sporne.length > 0 && `, ${sporne.length} sporných (nebudou uložena, viz níž)`}.
              </span>
              {status !== "saved" && (
                <button
                  onClick={handleSave}
                  disabled={pripraveno.length === 0 || status === "saving"}
                  className="rounded-md bg-accent px-4 py-1.5 text-[12.5px] font-bold tracking-wide text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === "saving" ? "Ukládám…" : `Uložit ${pripraveno.length} cen`}
                </button>
              )}
            </div>

            {status === "saved" && savedInfo && (
              <p className="rounded-md bg-green-50 px-3 py-2 text-[12.5px] font-semibold text-status-ok">
                Úspěšně uloženo {savedInfo.ulozeno} cen do ceníku
                {savedInfo.preskocenoStarsi > 0 &&
                  ` (${savedInfo.preskocenoStarsi} přeskočeno – appka už měla uloženou cenu z novější nabídky)`}
                .
              </p>
            )}

            {sporne.length > 0 && (
              <details className="text-[12px] text-gray-500" open>
                <summary className="cursor-pointer font-semibold text-status-overdue">
                  Sporná čísla zařízení ({sporne.length}) – nebyla uložena
                </summary>
                <ul className="mt-1 list-inside list-disc">
                  {sporne.map((s, i) => (
                    <li key={i}>
                      {s.cislo_zarizeni}: {s.duvod}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {pripraveno.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500">
                      <th className="py-1.5 pr-4 font-semibold">Číslo zařízení</th>
                      <th className="py-1.5 pr-4 font-semibold">Popis</th>
                      <th className="py-1.5 pr-4 font-semibold">Cena</th>
                      <th className="py-1.5 pr-4 font-semibold">Nabídka</th>
                      <th className="py-1.5 pr-4 font-semibold">Soubor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pripraveno.slice(0, 50).map((p, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="py-1.5 pr-4">{p.cislo_zarizeni}</td>
                        <td className="py-1.5 pr-4">{p.popis || "—"}</td>
                        <td className="py-1.5 pr-4 font-semibold">{formatCena(p.cena)}</td>
                        <td className="py-1.5 pr-4">
                          {p.cislo_nabidky || "—"}
                          {p.datum_nabidky && ` (${p.datum_nabidky.toLocaleDateString("cs-CZ", { timeZone: "UTC" })})`}
                        </td>
                        <td className="py-1.5 pr-4 text-gray-400">{p.soubor_nazev}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {pripraveno.length > 50 && (
                  <p className="mt-1 text-[11px] text-gray-400">
                    Zobrazeno prvních 50 z {pripraveno.length} položek.
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

type CenikRow = {
  id: string;
  cislo_zarizeni: string;
  popis: string;
  cena: number;
  cislo_nabidky: string | null;
  datum_nabidky: Date | null;
  soubor_nazev: string;
  nahrano: Date | null;
};

function useCenik(reloadKey: number) {
  const [rows, setRows] = useState<CenikRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const snap = await getDocs(query(collection(db, CENIK_COLLECTION), orderBy("cislo_zarizeni", "asc")));
        if (cancelled) return;
        const loaded: CenikRow[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            cislo_zarizeni: typeof data.cislo_zarizeni === "string" ? data.cislo_zarizeni : d.id,
            popis: typeof data.popis === "string" ? data.popis : "",
            cena: typeof data.cena === "number" ? data.cena : 0,
            cislo_nabidky: typeof data.cislo_nabidky === "string" ? data.cislo_nabidky : null,
            datum_nabidky: data.datum_nabidky instanceof Timestamp ? data.datum_nabidky.toDate() : null,
            soubor_nazev: typeof data.soubor_nazev === "string" ? data.soubor_nazev : "",
            nahrano: data.nahrano instanceof Timestamp ? data.nahrano.toDate() : null,
          };
        });
        setRows(loaded);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Nepodařilo se načíst ceník. Zkus to prosím znovu.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return { rows, loading, error };
}

function CenikPrehled({ reloadKey }: { reloadKey: number }) {
  const { rows, loading, error } = useCenik(reloadKey);
  const [searchText, setSearchText] = useState("");
  const trimmedSearch = searchText.trim();
  const searchNeedle = trimmedSearch ? normalizeSearchText(trimmedSearch) : "";

  const visibleRows = rows
    ? rows.filter(
        (row) =>
          !searchNeedle ||
          normalizeSearchText(row.cislo_zarizeni).includes(searchNeedle) ||
          normalizeSearchText(row.popis).includes(searchNeedle)
      )
    : [];

  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-sm">
      <div className="flex items-center justify-between bg-navy px-[18px] py-2.5 text-[13px] font-bold text-white">
        <span>Ceník</span>
        <span className="text-[12px] font-normal text-white/60">
          {rows ? `${visibleRows.length} záznamů` : loading ? "Načítám…" : "0 záznamů"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-[18px] py-3">
        <span className="text-[11px] font-bold uppercase tracking-wide text-navy">Vyhledávání:</span>
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Hledat podle čísla zařízení nebo popisu…"
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-[13px] outline-none focus:border-accent focus:ring-1 focus:ring-accent sm:w-64"
        />
      </div>

      {error && <p className="mx-[18px] my-3 rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-600">{error}</p>}

      {loading && (
        <div className="px-[18px] py-10 text-center text-[13px] text-gray-400">Načítám ceník…</div>
      )}

      {!loading && rows && visibleRows.length === 0 && (
        <div className="px-[18px] py-10 text-center text-[13px] text-gray-400">
          {searchNeedle
            ? "Žádné záznamy neodpovídají hledání."
            : "Ceník je zatím prázdný. Nahraj cenovou nabídku (PDF) výš, ať appka ceny naimportuje."}
        </div>
      )}

      {!loading && rows && visibleRows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-2 pl-[18px] pr-4 font-semibold">Číslo zařízení</th>
                <th className="py-2 pr-4 font-semibold">Popis</th>
                <th className="py-2 pr-4 font-semibold">Cena</th>
                <th className="py-2 pr-4 font-semibold">Nabídka</th>
                <th className="py-2 pr-[18px] font-semibold">Aktualizováno</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.id} className="border-b border-gray-100">
                  <td className="py-2 pl-[18px] pr-4">{row.cislo_zarizeni}</td>
                  <td className="py-2 pr-4">{row.popis || "—"}</td>
                  <td className="py-2 pr-4 font-semibold">{formatCena(row.cena)}</td>
                  <td className="py-2 pr-4">
                    {row.cislo_nabidky || "—"}
                    {row.datum_nabidky &&
                      ` (${row.datum_nabidky.toLocaleDateString("cs-CZ", { timeZone: "UTC" })})`}
                  </td>
                  <td className="py-2 pr-[18px] text-gray-400">{row.nahrano ? formatLogCas(row.nahrano) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function CenikPage() {
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <AuthGate>
      {(user) => (
        <div className="flex min-h-full flex-1 flex-col bg-[#eef1f5]">
          <AppHeader user={user} />
          <AppNav />

          <div className="flex flex-col gap-4 px-7 py-6">
            <CenikUpload onUlozeno={() => setReloadKey((k) => k + 1)} />
            <CenikPrehled reloadKey={reloadKey} />
          </div>
        </div>
      )}
    </AuthGate>
  );
}
