// "legacy" build – viz stejný komentář u importu v lib/pdfRevizniZprava.ts
// (appka běží jak v prohlížeči, tak v Node skriptu; legacy build funguje beze
// změny v obou prostředích).
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { yieldToMainThread } from "./yieldToMainThread";

export type ParsedCenikPolozka = {
  cislo_zarizeni: string;
  popis: string;
  cena: number;
  stranka: number;
};

export type ParseCenikResult = {
  /** Číslo cenové nabídky (např. "2025/011"), nebo null, pokud se nepodařilo najít. */
  cislo_nabidky: string | null;
  /** Datum nabídky (z "ze dne DD.MM.YYYY"), nebo null. */
  datum_nabidky: Date | null;
  polozky: ParsedCenikPolozka[];
};

// pdf.worker.min.mjs v /public – viz stejný komentář v lib/pdfRevizniZprava.ts.
let workerConfigured = false;
async function ensureWorker() {
  if (workerConfigured) return;
  if (typeof window !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  } else {
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const require = createRequire(import.meta.url);
    // pathToFileURL() – Node ESM loader (na rozdíl od CommonJS) vyžaduje u
    // dynamického import() platnou "file://" URL, ne holou cestu. Na Windows
    // je to KRITICKÉ (require.resolve() vrací "C:\...\pdf.worker.min.mjs" –
    // dvojtečka za písmenem disku vypadá pro URL parser jako neznámé
    // schéma "c:", takže import() bez týhle konverze na Windows vždycky
    // spadne na "Setting up fake worker failed"); na Linuxu/macOS je čistá
    // cesta zase náhodou validní file URL i bez schématu, takže tam rozdíl
    // není vidět.
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs")
    ).href;
  }
  workerConfigured = true;
}

type TextItem = { str: string; transform: number[] };

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

type Cell = { x: number; str: string };
type Row = { y: number; cells: Cell[] };

/**
 * Poskládá textové položky stránky do řádků podle Y souřadnice (s malou
 * tolerancí – viz stejný přístup v lib/pdfRevizniZprava.ts), ale na rozdíl od
 * tamní reconstructLines() NESPOJUJE buňky do jednoho řetězce – appka tady
 * potřebuje vědět X souřadnici každé buňky zvlášť, aby poznala, do kterého
 * sloupce tabulky (Položka / číslo zařízení / cena celkem…) patří (řádky bez
 * čísla zařízení mají prostě míň buněk, spojení podle POŘADÍ by je vzájemně
 * posunulo).
 */
function groupRows(items: (TextItem | unknown)[]): Row[] {
  const TOLERANCE = 2.5;
  const rows: Row[] = [];

  for (const raw of items) {
    if (!isTextItem(raw) || !raw.str.trim()) continue;
    const y = raw.transform[5];
    const x = raw.transform[4];
    let row = rows.find((r) => Math.abs(r.y - y) <= TOLERANCE);
    if (!row) {
      row = { y, cells: [] };
      rows.push(row);
    }
    row.cells.push({ x, str: raw.str });
  }

  rows.sort((a, b) => b.y - a.y); // PDF Y roste směrem nahoru -> řadíme shora dolů
  rows.forEach((r) => r.cells.sort((a, b) => a.x - b.x));
  return rows;
}

// Hranice sloupců tabulky "Položka / Příkon (kW) / MJ / poč. / cena/MJ / cena
// celkem" zjištěné ze skutečných nabídek (viz X souřadnice v reálných PDF) –
// šablona nabídek je napříč měsíci stejná (stejný generátor), takže by měly
// sedět na všechny. Sloupec "cena celkem" (odsud appka bere cenu) má vždycky
// formát "1 234 Kč", ostatní číselné sloupce (cena/MJ, kW, počet) ne – podle
// přítomnosti "Kč" v buňce se dá spolehlivě poznat, i kdyby se X souřadnice
// mezi verzemi šablony mírně posunula.
const SLOUPEC_CISLO_ZARIZENI: [number, number] = [190, 305];
const SLOUPEC_CENA_CELKEM_MIN = 440;

function parseCenaKc(text: string): number | null {
  if (!text.includes("Kč")) return null;
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return null;
  return Number(digits);
}

/**
 * Z jednoho řádku tabulky vytáhne položku ceníku – POUZE pokud řádek má jak
 * číslo zařízení (sloupec kolem X 190–305), tak cenu celkem (buňka s "Kč").
 * Řádky bez čísla zařízení (souhrnné položky typu "Revize osvětlení" bez
 * vazby na konkrétní stroj) i hlavičkový/patičkový řádek ("Položka…",
 * "Cena celkem (bez DPH)") tak appka automaticky přeskočí – nemají se s čím
 * v appce (kolekce "planovane_revize") spárovat podle čísla zařízení.
 */
function extractPolozka(row: Row, stranka: number): ParsedCenikPolozka | null {
  const kodCells = row.cells.filter(
    (c) => c.x >= SLOUPEC_CISLO_ZARIZENI[0] && c.x <= SLOUPEC_CISLO_ZARIZENI[1]
  );
  const cenaCell = row.cells.find((c) => c.x >= SLOUPEC_CENA_CELKEM_MIN && c.str.includes("Kč"));
  if (kodCells.length === 0 || !cenaCell) return null;

  const cislo_zarizeni = kodCells.map((c) => c.str).join(" ").trim();
  const cena = parseCenaKc(cenaCell.str);
  if (!cislo_zarizeni || cena === null) return null;

  const popis = row.cells
    .filter((c) => c.x < SLOUPEC_CISLO_ZARIZENI[0])
    .map((c) => c.str)
    .join(" ")
    .trim();

  return { cislo_zarizeni, popis, cena, stranka };
}

const NABIDKA_HLAVICKA_RE = /^(\S+)\s+ze dne\s+(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

/**
 * Vytáhne z libovolné položky textu na první stránce číslo a datum nabídky
 * (appka je hledá podle obsahu, NE podle pozice v poli položek – v content
 * streamu PDF bývá hlavička nabídky zapsaná AŽ ZA celou tabulkou položek,
 * appka na jejím pořadí nesmí záviset).
 */
function extractHlavickaNabidky(items: (TextItem | unknown)[]): {
  cislo_nabidky: string | null;
  datum_nabidky: Date | null;
} {
  for (const raw of items) {
    if (!isTextItem(raw)) continue;
    const match = raw.str.trim().match(NABIDKA_HLAVICKA_RE);
    if (!match) continue;
    const [, cislo, d, m, y] = match;
    return {
      cislo_nabidky: cislo,
      datum_nabidky: new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))),
    };
  }
  return { cislo_nabidky: null, datum_nabidky: null };
}

export type CenikSouborVysledek = {
  soubor: string;
  cislo_nabidky: string | null;
  datum_nabidky: Date | null;
  polozky: ParsedCenikPolozka[];
};

export type ResolvenaCenikPolozka = {
  cislo_zarizeni: string;
  popis: string;
  cena: number;
  cislo_nabidky: string | null;
  datum_nabidky: Date | null;
  soubor_nazev: string;
};

export type SpornaCenikPolozka = {
  cislo_zarizeni: string;
  duvod: string;
};

/**
 * Z nabídek NAHRANÝCH V JEDNÉ DÁVCE vybere za každé číslo zařízení JEDNU
 * výslednou cenu – appka bere cenu z NEJNOVĚJŠÍ nabídky (podle
 * "ze dne …"), protože stejné zařízení se v čase objevuje v nabídkách
 * opakovaně (revize se dělá pravidelně) a appka má zákazníkovi ukazovat
 * aktuální cenu, ne tu nejstarší nahranou. Nabídka bez rozpoznaného data má
 * nejnižší prioritu (appka nemá jak porovnat, jestli je novější/starší než
 * ostatní).
 *
 * Číslo zařízení, které se v RÁMCI JEDNOHO souboru objeví vícekrát s
 * RŮZNOU cenou (viz komentář u extractPolozka výš – reálně se to v
 * nabídkách stává, typicky překlep/duplicitní řádek), appka NEUMÍ
 * jednoznačně rozhodnout – takové zařízení radši vůbec neuloží a vrátí ho
 * zvlášť ve "sporne", ať si ho člověk zkontroluje přímo v PDF. Stejně se
 * řeší i shoda na nejnovějším datu mezi dvěma RŮZNÝMI soubory s odlišnou
 * cenou (nelze rozhodnout, který je "novější").
 */
export function vyresitCenikSoubory(soubory: CenikSouborVysledek[]): {
  pripraveno: ResolvenaCenikPolozka[];
  sporne: SpornaCenikPolozka[];
} {
  const sporneSet = new Set<string>();
  const kandidati = new Map<string, ResolvenaCenikPolozka[]>();

  for (const soubor of soubory) {
    const podleKodu = new Map<string, ParsedCenikPolozka[]>();
    for (const p of soubor.polozky) {
      if (!podleKodu.has(p.cislo_zarizeni)) podleKodu.set(p.cislo_zarizeni, []);
      podleKodu.get(p.cislo_zarizeni)!.push(p);
    }

    for (const [kod, seznam] of podleKodu) {
      const uniqCeny = new Set(seznam.map((p) => p.cena));
      if (uniqCeny.size > 1) {
        sporneSet.add(kod);
        continue;
      }
      const p = seznam[0];
      if (!kandidati.has(kod)) kandidati.set(kod, []);
      kandidati.get(kod)!.push({
        cislo_zarizeni: kod,
        popis: p.popis,
        cena: p.cena,
        cislo_nabidky: soubor.cislo_nabidky,
        datum_nabidky: soubor.datum_nabidky,
        soubor_nazev: soubor.soubor,
      });
    }
  }

  const pripraveno: ResolvenaCenikPolozka[] = [];

  for (const [kod, seznam] of kandidati) {
    if (sporneSet.has(kod)) continue;

    const serazeno = [...seznam].sort((a, b) => {
      const at = a.datum_nabidky ? a.datum_nabidky.getTime() : -Infinity;
      const bt = b.datum_nabidky ? b.datum_nabidky.getTime() : -Infinity;
      return bt - at;
    });
    const vitez = serazeno[0];
    const vitezCas = vitez.datum_nabidky ? vitez.datum_nabidky.getTime() : -Infinity;
    const remizaSRuznouCenou = serazeno.some(
      (p) => (p.datum_nabidky ? p.datum_nabidky.getTime() : -Infinity) === vitezCas && p.cena !== vitez.cena
    );
    if (remizaSRuznouCenou) {
      sporneSet.add(kod);
      continue;
    }
    pripraveno.push(vitez);
  }

  const sporne: SpornaCenikPolozka[] = Array.from(sporneSet).map((cislo_zarizeni) => ({
    cislo_zarizeni,
    duvod: "V nabídkách se pro tohle číslo zařízení objevují různé ceny – zkontroluj ručně v PDF.",
  }));

  return { pripraveno, sporne };
}

export async function parseCenikPdf(data: ArrayBuffer): Promise<ParseCenikResult> {
  await ensureWorker();

  // .slice(0) – viz kritický komentář u stejného volání v
  // lib/pdfRevizniZprava.ts: getDocument() převezme vlastnictví bufferu a
  // detachne ho, appka ale potřebuje originál použitelný i po návratu.
  const loadingTask = pdfjsLib.getDocument({ data: data.slice(0) });
  try {
    const doc = await loadingTask.promise;
    let cislo_nabidky: string | null = null;
    let datum_nabidky: Date | null = null;
    const polozky: ParsedCenikPolozka[] = [];

    for (let stranka = 1; stranka <= doc.numPages; stranka++) {
      if (stranka > 1 && stranka % 5 === 0) {
        await yieldToMainThread();
      }

      const page = await doc.getPage(stranka);
      const content = await page.getTextContent();

      if (stranka === 1) {
        const hlavicka = extractHlavickaNabidky(content.items);
        cislo_nabidky = hlavicka.cislo_nabidky;
        datum_nabidky = hlavicka.datum_nabidky;
      }

      const rows = groupRows(content.items);
      for (const row of rows) {
        const polozka = extractPolozka(row, stranka);
        if (polozka) polozky.push(polozka);
      }
    }

    return { cislo_nabidky, datum_nabidky, polozky };
  } finally {
    await loadingTask.destroy();
  }
}
