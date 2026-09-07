import * as XLSX from "xlsx";
import { parseFlexibleDate } from "@/lib/parseDate";

export type ParsedPlanRow = {
  cislo_zarizeni: string;
  popis: string;
  termin: Date;
  frekvence: number | null;
  jednotky_frekvence: string;
};

export type ParseSkip = {
  row: number;
  reason: string;
};

export type ParsePlanResult = {
  rows: ParsedPlanRow[];
  skipped: ParseSkip[];
};

function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// Maximo export vede číslo zařízení/stroje (mix čísel a kódů jako "211508", "IMM002", "ZZ015")
// ve sloupci "Původní aktivum" – ten má přednost, "Aktivum" je jen fallback.
function isOriginalAssetHeader(h: string): boolean {
  return /puvodni.*aktiv/.test(h);
}

function isFallbackDeviceHeader(h: string): boolean {
  return /cislo.*zariz|cislo.*aktiv|^aktivum$|^zarizeni$|assetnum|^asset$|equipment/.test(h);
}

function isDescriptionHeader(h: string): boolean {
  return /popis|description/.test(h);
}

function isDateHeader(h: string): boolean {
  return /predpoklad.*dokonc|planovane.*dokonc|datum.*dokonc|^termin/.test(h);
}

function isFrequencyUnitHeader(h: string): boolean {
  return /jednotk.*frekvenc|frekvenc.*jednotk/.test(h);
}

function isFrequencyHeader(h: string): boolean {
  return /frekvenc/.test(h) && !isFrequencyUnitHeader(h);
}

/**
 * Maximo občas exportuje ".xls", který je ve skutečnosti HTML tabulka
 * uložená s příponou .xls, nikoli skutečný binární/OOXML sešit.
 */
function sniffAsText(data: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

function isHtmlDocument(text: string): boolean {
  return /<html|<table/i.test(text);
}

function detectHtmlCharset(sniffed: string): string | null {
  const match = sniffed.match(/<meta[^>]*charset\s*=\s*["']?\s*([\w-]+)/i);
  if (!match) return null;
  let charset = match[1].toLowerCase();
  if (/1250/.test(charset)) charset = "windows-1250";
  else if (/1252/.test(charset)) charset = "windows-1252";
  else if (charset === "utf8") charset = "utf-8";
  return charset;
}

function decodeHtml(data: ArrayBuffer, sniffed: string): string {
  const charset = detectHtmlCharset(sniffed);
  if (!charset || charset === "utf-8") return sniffed;
  try {
    return new TextDecoder(charset, { fatal: false }).decode(data);
  } catch {
    // neznámé/nepodporované kódování v prohlížeči – zůstaneme u UTF-8 sniffnutí
    return sniffed;
  }
}

/** Vybere v HTML dokumentu tabulku s nejvíce řádky (obvykle je to ta datová). */
function parseHtmlTableRows(html: string): Record<string, unknown>[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables = Array.from(doc.querySelectorAll("table"));
  if (tables.length === 0) {
    throw new Error("V souboru (HTML) se nepodařilo najít žádnou tabulku.");
  }

  const table = tables.reduce((best, current) =>
    current.querySelectorAll("tr").length > best.querySelectorAll("tr").length ? current : best
  );

  const trs = Array.from(table.querySelectorAll("tr"));
  if (trs.length < 2) return [];

  const headerCells = Array.from(trs[0].querySelectorAll("th, td")).map(
    (cell) => (cell.textContent ?? "").trim()
  );

  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < trs.length; i++) {
    const cells = Array.from(trs[i].querySelectorAll("th, td"));
    if (cells.length === 0) continue;
    const row: Record<string, unknown> = {};
    headerCells.forEach((header, idx) => {
      const key = header || `sloupec_${idx + 1}`;
      row[key] = cells[idx] ? (cells[idx].textContent ?? "").trim() : null;
    });
    rows.push(row);
  }
  return rows;
}

function readRawRows(data: ArrayBuffer): Record<string, unknown>[] {
  const sniffed = sniffAsText(data);

  if (isHtmlDocument(sniffed)) {
    const html = decodeHtml(data, sniffed);
    return parseHtmlTableRows(html);
  }

  try {
    const workbook = XLSX.read(data, { type: "array", cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  } catch {
    throw new Error(
      "Soubor se nepodařilo přečíst jako Excel ani jako HTML tabulku. Zkontroluj, že jde o platný export plánu revizí (.xls/.xlsx), a zkus to nahrát znovu."
    );
  }
}

/**
 * Naparsuje export plánu revizí (sloupce podobné Maximo exportu) – ať už jde
 * o skutečný binární/OOXML sešit, nebo o HTML tabulku uloženou s příponou .xls.
 * Názvy sloupců hledá flexibilně (bez diakritiky, různé pořadí).
 */
export function parsePlanWorkbook(data: ArrayBuffer): ParsePlanResult {
  const rawRows = readRawRows(data);

  const rows: ParsedPlanRow[] = [];
  const skipped: ParseSkip[] = [];

  if (rawRows.length === 0) {
    return { rows, skipped };
  }

  const headers = Object.keys(rawRows[0]);
  const deviceHeader =
    headers.find((h) => isOriginalAssetHeader(normalizeHeader(h))) ??
    headers.find((h) => isFallbackDeviceHeader(normalizeHeader(h)));
  const descHeader = headers.find((h) => isDescriptionHeader(normalizeHeader(h)));
  const dateHeader = headers.find((h) => isDateHeader(normalizeHeader(h)));
  const frequencyHeader = headers.find((h) => isFrequencyHeader(normalizeHeader(h)));
  const frequencyUnitHeader = headers.find((h) => isFrequencyUnitHeader(normalizeHeader(h)));

  if (!deviceHeader || !dateHeader) {
    throw new Error(
      "V souboru se nepodařilo najít sloupec s číslem zařízení a/nebo termínem (Předpokládané dokončení). Zkontroluj hlavičky sloupců."
    );
  }

  rawRows.forEach((row, index) => {
    const excelRowNumber = index + 2; // +1 za hlavičku, +1 protože index je od 0
    const cisloRaw = row[deviceHeader];
    const cislo_zarizeni = cisloRaw === null || cisloRaw === undefined ? "" : String(cisloRaw).trim();
    const termin = parseFlexibleDate(row[dateHeader]);
    const popis = descHeader && row[descHeader] != null ? String(row[descHeader]).trim() : "";
    const frekvenceRaw = frequencyHeader ? row[frequencyHeader] : null;
    const frekvence =
      frekvenceRaw !== null && frekvenceRaw !== undefined && frekvenceRaw !== ""
        ? Number(frekvenceRaw)
        : null;
    const jednotky_frekvence =
      frequencyUnitHeader && row[frequencyUnitHeader] != null
        ? String(row[frequencyUnitHeader]).trim()
        : "";

    if (!cislo_zarizeni) {
      skipped.push({ row: excelRowNumber, reason: "chybí číslo zařízení" });
      return;
    }
    if (!termin) {
      skipped.push({ row: excelRowNumber, reason: "nepodařilo se přečíst termín" });
      return;
    }

    rows.push({
      cislo_zarizeni,
      popis,
      termin,
      frekvence: frekvence !== null && !isNaN(frekvence) ? frekvence : null,
      jednotky_frekvence,
    });
  });

  return { rows, skipped };
}
