import * as pdfjsLib from "pdfjs-dist";
import { parseFlexibleDate } from "@/lib/parseDate";

export type ParsedRevizniZprava = {
  cislo_zarizeni: string;
  datum_provedeni: Date;
  novy_termin: Date;
  /** "Vyhovuje" / "Nevyhovuje" apod. – prázdné, pokud se nepodařilo rozpoznat. */
  celkove_hodnoceni: string;
  /** 1-based číslo stránky uvnitř nahraného PDF. */
  stranka: number;
};

export type SkippedPage = {
  stranka: number;
  duvod: string;
};

export type ParseRevizniZpravyResult = {
  zpravy: ParsedRevizniZprava[];
  preskoceno: SkippedPage[];
};

// pdf.worker.min.mjs v /public je zkopírovaný přímo z nainstalované verze
// pdfjs-dist (node_modules/pdfjs-dist/build/pdf.worker.min.mjs) – API a worker
// verze musí přesně sedět, jinak pdf.js odmítne dokument otevřít. Při update
// balíčku pdfjs-dist je potřeba worker soubor v /public zkopírovat znovu.
let workerConfigured = false;
function ensureWorker() {
  if (workerConfigured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  workerConfigured = true;
}

type TextItem = { str: string; transform: number[] };

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

/**
 * Poskládá textové položky ze stránky PDF do řádků podle Y souřadnice (s malou
 * tolerancí) a v rámci řádku je seřadí podle X – tím se přiblíží výstupu
 * "pdftotext -layout" (popisek a hodnota vedle sebe na stejném vizuálním
 * řádku), na rozdíl od prostého spojení textových položek v pořadí, v jakém
 * jsou uložené v PDF (to bývá jinak, viz pořadí sloupců v tabulce).
 */
function reconstructLines(items: (TextItem | unknown)[]): string[] {
  const TOLERANCE = 2.5;
  const rows: { y: number; cells: { x: number; str: string }[] }[] = [];

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
  return rows.map((r) =>
    r.cells
      .sort((a, b) => a.x - b.x)
      .map((c) => c.str)
      .join("  ")
  );
}

const CZECH_MONTHS: Record<string, number> = {
  leden: 1,
  únor: 2,
  březen: 3,
  duben: 4,
  květen: 5,
  červen: 6,
  červenec: 7,
  srpen: 8,
  září: 9,
  říjen: 10,
  listopad: 11,
  prosinec: 12,
};

function findValueAfterLabel(lines: string[], labelPattern: RegExp): string | null {
  for (const line of lines) {
    const match = line.match(labelPattern);
    if (match) return match[1];
  }
  return null;
}

/** "nejpozději do" -> konzervativně poslední den daného měsíce (den 0 následujícího měsíce). */
function lastDayOfMonth(year: number, month: number): Date {
  return new Date(year, month, 0);
}

// ---------------------------------------------------------------------------
// Šablona A: "Protokol o pravidelné revizi elektrického spotřebiče"
// (program ILLKO Studio, dle ČSN 33 1600 ed.2).
// ---------------------------------------------------------------------------

function extractInventarniCisloSpotrebic(lines: string[]): string | null {
  return findValueAfterLabel(lines, /Inventární\s*číslo:\s*(\S+)/);
}

function extractDatumProvedeniSpotrebic(lines: string[]): Date | null {
  const raw = findValueAfterLabel(lines, /Revize byla provedena dne:\s*(\d{1,2}\.\d{1,2}\.\d{4})/);
  return raw ? parseFlexibleDate(raw) : null;
}

function parseTerminValueSpotrebic(raw: string): Date | null {
  const text = raw.trim();

  const exact = parseFlexibleDate(text);
  if (exact) return exact;

  const monthMatch = text.match(/^(\p{L}+)\s+(\d{4})/u);
  if (monthMatch) {
    const month = CZECH_MONTHS[monthMatch[1].toLowerCase()];
    const year = Number(monthMatch[2]);
    if (month) return lastDayOfMonth(year, month);
  }

  return null;
}

function extractTerminSpotrebic(lines: string[]): Date | null {
  const raw = findValueAfterLabel(lines, /Řádný termín příští revize je nejpozději do:\s*(.+)/);
  return raw ? parseTerminValueSpotrebic(raw) : null;
}

/**
 * "Celkové hodnocení:" bývá v záhlaví dvouřádkově – na řádku s popiskem
 * někdy nic nenásleduje a samotná hodnota ("Vyhovuje") je až na dalším
 * řádku za podtitulkem "dle ČSN 33 1600 ed.2" (ověřeno na reálné zprávě).
 * Zkusí tedy nejdřív stejný řádek, pak jako poslední token řádku pod ním.
 */
function extractCelkoveHodnoceniSpotrebic(lines: string[]): string {
  const idx = lines.findIndex((l) => /Celkové hodnocení:/.test(l));
  if (idx === -1) return "";

  const afterLabel = lines[idx].split(/Celkové hodnocení:/)[1]?.trim();
  const sameLineToken = afterLabel?.split(/\s+/).filter(Boolean)[0];
  if (sameLineToken) return sameLineToken;

  const nextLineTokens = lines[idx + 1]?.trim().split(/\s+/).filter(Boolean);
  if (nextLineTokens && nextLineTokens.length > 0) {
    return nextLineTokens[nextLineTokens.length - 1];
  }

  return "";
}

function extractSpotrebicZprava(lines: string[]) {
  return {
    cislo_zarizeni: extractInventarniCisloSpotrebic(lines),
    datum_provedeni: extractDatumProvedeniSpotrebic(lines),
    novy_termin: extractTerminSpotrebic(lines),
    celkove_hodnoceni: extractCelkoveHodnoceniSpotrebic(lines),
  };
}

// ---------------------------------------------------------------------------
// Šablona B: "Zpráva o revizi elektrického zařízení pracovního stroje"
// (dle ČSN EN 60204-1) – jiná revizní firma/formulář, ověřeno na reálné
// zprávě "165022 1-2026.pdf".
// ---------------------------------------------------------------------------

function extractInventarniCisloStroj(lines: string[]): string | null {
  // Popisek bez dvojtečky, hodnota má často prefix "EAN:" (např. "EAN: 165022").
  return findValueAfterLabel(lines, /Inventární\s*číslo\s*:?\s*(?:EAN:\s*)?(\S+)/);
}

/** "17. leden 2026" -> den 17, měsíc leden, rok 2026 (nesklonný název měsíce). */
function parseDenMesicRok(raw: string): Date | null {
  const match = raw.trim().match(/^(\d{1,2})\.\s*(\p{L}+)\s+(\d{4})/u);
  if (!match) return null;
  const day = Number(match[1]);
  const month = CZECH_MONTHS[match[2].toLowerCase()];
  const year = Number(match[3]);
  if (!month) return null;
  const date = new Date(year, month - 1, day);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * "Datum revize:" bývá dvouřádkově stejně jako "Celkové hodnocení:" v šabloně
 * A – popisek na konci řádku, hodnota "17. leden 2026" na řádku pod ním.
 * Když se nenajde, použije se jako záloha jednodušší "Datum:" u podpisu
 * technika (formát DD.MM.RRRR), který na reálné zprávě označuje stejné datum.
 */
function extractDatumProvedeniStroj(lines: string[]): Date | null {
  const idx = lines.findIndex((l) => /Datum revize:/.test(l));
  if (idx !== -1) {
    const afterLabel = lines[idx].split(/Datum revize:/)[1]?.trim();
    if (afterLabel) {
      const inline = parseDenMesicRok(afterLabel) ?? parseFlexibleDate(afterLabel);
      if (inline) return inline;
    }
    const nextLine = lines[idx + 1]?.trim();
    if (nextLine) {
      const tail = nextLine.split(/\s+/).slice(-3).join(" ");
      const belowLabel = parseDenMesicRok(tail);
      if (belowLabel) return belowLabel;
    }
  }

  const raw = findValueAfterLabel(lines, /\bDatum:\s*(\d{1,2}\.\d{1,2}\.\d{4})/);
  return raw ? parseFlexibleDate(raw) : null;
}

/** "1/2027" (měsíc/rok) -> konzervativně poslední den daného měsíce. */
function parseMesicRok(raw: string): Date | null {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  const month = Number(match[1]);
  const year = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return lastDayOfMonth(year, month);
}

function extractTerminStroj(lines: string[]): Date | null {
  const raw = findValueAfterLabel(lines, /Stanovení termínu další revize:\s*(.+)/);
  return raw ? parseMesicRok(raw) : null;
}

/**
 * "Celkový posudek:" je tu celý odstavec prózy, ne jedno slovo jako
 * "Vyhovuje" v šabloně A – bereme jen text na stejném řádku jako popisek
 * (typicky první věta), ať se do UI needitujeme vměstnávat celý odstavec.
 */
function extractPosudekStroj(lines: string[]): string {
  const idx = lines.findIndex((l) => /Celkový posudek:/.test(l));
  if (idx === -1) return "";
  return lines[idx].split(/Celkový posudek:/)[1]?.trim() ?? "";
}

function extractStrojZprava(lines: string[]) {
  return {
    cislo_zarizeni: extractInventarniCisloStroj(lines),
    datum_provedeni: extractDatumProvedeniStroj(lines),
    novy_termin: extractTerminStroj(lines),
    celkove_hodnoceni: extractPosudekStroj(lines),
  };
}

// ---------------------------------------------------------------------------

type Sablona = "spotrebic" | "pracovni_stroj";

/** Podle nadpisu na stránce pozná, kterou ze dvou známých šablon použít. */
function detectSablona(lines: string[]): Sablona | null {
  const text = lines.join("\n");
  if (/revizi elektrického zařízení pracovního stroje/.test(text)) return "pracovni_stroj";
  if (/revizi elektrického spotřebiče/.test(text)) return "spotrebic";
  return null;
}

/**
 * Naparsuje jednu nebo víc revizních zpráv z PDF – stránku po stránce
 * (jeden nahraný soubor může obsahovat revizní zprávy pro víc zařízení,
 * jednu na stránku). Číslo zařízení a všechny ostatní údaje se čtou
 * výhradně z textového obsahu PDF, nikdy z názvu souboru. Podporuje dvě
 * reálně ověřené šablony revizních zpráv (viz detectSablona výše) a stránky
 * neodpovídající žádné z nich přeskočí se srozumitelným důvodem.
 */
export async function parseRevizniZpravyPdf(data: ArrayBuffer): Promise<ParseRevizniZpravyResult> {
  ensureWorker();

  // getDocument() převezme vlastnictví předaného ArrayBufferu a přesune ho
  // (detached) do web workeru – jakékoli další použití originálu (např. upload
  // téhož souboru do Firebase Storage volajícím kódem) by pak spadlo na
  // "Cannot perform Construct on a detached ArrayBuffer". Voláme proto na
  // nezávislé kopii, ať buffer volajícího zůstane použitelný i po návratu.
  const doc = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
  const zpravy: ParsedRevizniZprava[] = [];
  const preskoceno: SkippedPage[] = [];

  for (let stranka = 1; stranka <= doc.numPages; stranka++) {
    const page = await doc.getPage(stranka);
    const content = await page.getTextContent();
    const lines = reconstructLines(content.items);

    const sablona = detectSablona(lines);
    if (!sablona) {
      preskoceno.push({ stranka, duvod: "nerozpoznaný typ revizní zprávy" });
      continue;
    }

    const extracted = sablona === "spotrebic" ? extractSpotrebicZprava(lines) : extractStrojZprava(lines);
    const sablonaPopis = sablona === "spotrebic" ? "spotřebič" : "pracovní stroj";

    if (!extracted.cislo_zarizeni) {
      preskoceno.push({ stranka, duvod: `nepodařilo se najít Inventární číslo (šablona: ${sablonaPopis})` });
      continue;
    }

    if (!extracted.datum_provedeni) {
      preskoceno.push({ stranka, duvod: `nepodařilo se najít datum provedení revize (šablona: ${sablonaPopis})` });
      continue;
    }

    if (!extracted.novy_termin) {
      preskoceno.push({ stranka, duvod: `nepodařilo se rozpoznat termín příští revize (šablona: ${sablonaPopis})` });
      continue;
    }

    zpravy.push({
      cislo_zarizeni: extracted.cislo_zarizeni,
      datum_provedeni: extracted.datum_provedeni,
      novy_termin: extracted.novy_termin,
      celkove_hodnoceni: extracted.celkove_hodnoceni,
      stranka,
    });
  }

  return { zpravy, preskoceno };
}
