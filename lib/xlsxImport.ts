import * as XLSX from "xlsx";
import { parseFlexibleDate } from "@/lib/parseDate";
import { extractEquipmentNumber } from "@/lib/extractEquipmentNumber";

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

type RawTable = {
  headers: string[];
  rows: unknown[][];
};

function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isOriginalAssetHeader(h: string): boolean {
  return /puvodni.*aktiv/.test(h);
}

// Sloupec s holým číslem/kódem zařízení ("Aktivum" apod.) – ne "Původní aktivum".
function isPlainAssetHeader(h: string): boolean {
  return /^aktivum$|^zarizeni$|assetnum|^asset$|equipment/.test(h) && !isOriginalAssetHeader(h);
}

function isDescriptionHeader(h: string): boolean {
  return /popis|description/.test(h);
}

function isDateHeader(h: string): boolean {
  return /nejblizsi.*splatnosti|predpoklad.*dokonc|planovane.*dokonc|datum.*dokonc|^termin/.test(h);
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

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return "";
  return String(value)
    .replace(/ /g, " ")
    .trim();
}

/**
 * Vybere v HTML dokumentu tabulku s nejvíce řádky (obvykle je to ta datová)
 * a vrátí ji POZIČNĚ (pole hlaviček + pole řádků buněk), ne jako objekt
 * klíčovaný názvem sloupce – hlavičky se v Maximo exportu opakují
 * (např. "Popis" je ve stejné tabulce třikrát) a mapování podle názvu by
 * duplicitní sloupce přepisovalo/ztrácelo.
 */
function parseHtmlTableRows(html: string): RawTable {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables = Array.from(doc.querySelectorAll("table"));
  if (tables.length === 0) {
    throw new Error("V souboru (HTML) se nepodařilo najít žádnou tabulku.");
  }

  const table = tables.reduce((best, current) =>
    current.querySelectorAll("tr").length > best.querySelectorAll("tr").length ? current : best
  );

  const trs = Array.from(table.querySelectorAll("tr"));
  if (trs.length < 2) return { headers: [], rows: [] };

  const headers = Array.from(trs[0].querySelectorAll("th, td")).map((cell) =>
    cellText(cell.textContent)
  );

  const rows: unknown[][] = [];
  for (let i = 1; i < trs.length; i++) {
    const cells = Array.from(trs[i].querySelectorAll("th, td"));
    if (cells.length === 0) continue;
    rows.push(cells.map((cell) => cellText(cell.textContent)));
  }
  return { headers, rows };
}

function readRawTable(data: ArrayBuffer): RawTable {
  const sniffed = sniffAsText(data);

  if (isHtmlDocument(sniffed)) {
    const html = decodeHtml(data, sniffed);
    return parseHtmlTableRows(html);
  }

  try {
    const workbook = XLSX.read(data, { type: "array", cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    // header: 1 => pole polí (poziční), ne objekty klíčované názvem sloupce –
    // ze stejného důvodu jako u HTML tabulky výše (duplicitní názvy sloupců).
    const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
    const [headerRow, ...dataRows] = allRows;
    const headers = (headerRow ?? []).map((h) => cellText(h));
    return { headers, rows: dataRows };
  } catch {
    throw new Error(
      "Soubor se nepodařilo přečíst jako Excel ani jako HTML tabulku. Zkontroluj, že jde o platný export plánu revizí (.xls/.xlsx), a zkus to nahrát znovu."
    );
  }
}

/**
 * Naparsuje export plánu revizí (sloupce podobné Maximo exportu) – ať už jde
 * o skutečný binární/OOXML sešit, nebo o HTML tabulku uloženou s příponou .xls.
 * Sloupce se mapují podle POŘADÍ (indexu), ne podle názvu hlavičky – hlavička
 * "Popis" se v tomto exportu opakuje vícekrát (kód zařízení, popis aktiva,
 * popis pracovního postupu) a mapování podle názvu by je nešlo rozlišit.
 */
export function parsePlanWorkbook(data: ArrayBuffer): ParsePlanResult {
  const { headers, rows: rawRows } = readRawTable(data);

  const rows: ParsedPlanRow[] = [];
  const skipped: ParseSkip[] = [];

  if (headers.length === 0 || rawRows.length === 0) {
    return { rows, skipped };
  }

  const normalized = headers.map(normalizeHeader);

  const descIndices = normalized
    .map((h, i) => (isDescriptionHeader(h) ? i : -1))
    .filter((i) => i >= 0);
  const aktivumIndex = normalized.findIndex((h) => isPlainAssetHeader(h));
  const puvodniAktivumIndex = normalized.findIndex((h) => isOriginalAssetHeader(h));
  const dateIndex = normalized.findIndex((h) => isDateHeader(h));
  const frequencyIndex = normalized.findIndex((h) => isFrequencyHeader(h));
  const frequencyUnitIndex = normalized.findIndex((h) => isFrequencyUnitHeader(h));

  // V tomto exportu je "Popis" třikrát: kód zařízení (před sloupcem "Aktivum"),
  // popis aktiva (hned za "Aktivum") a popis pracovního postupu (na konci).
  const codeDescIndex =
    aktivumIndex >= 0
      ? [...descIndices].reverse().find((i) => i < aktivumIndex)
      : undefined;
  const assetDescIndex =
    aktivumIndex >= 0 ? descIndices.find((i) => i > aktivumIndex) : undefined;
  const fallbackDescIndex = descIndices[0];

  const hasDeviceSource = codeDescIndex !== undefined || aktivumIndex >= 0 || puvodniAktivumIndex >= 0;

  if (!hasDeviceSource || dateIndex < 0) {
    throw new Error(
      "V souboru se nepodařilo najít sloupec s číslem zařízení a/nebo termínem (Nejbližší další datum splatnosti). Zkontroluj hlavičky sloupců."
    );
  }

  rawRows.forEach((row, index) => {
    const excelRowNumber = index + 2; // +1 za hlavičku, +1 protože index je od 0

    const codeRaw = codeDescIndex !== undefined ? cellText(row[codeDescIndex]) : "";
    const aktivumRaw = aktivumIndex >= 0 ? cellText(row[aktivumIndex]) : "";
    const puvodniRaw = puvodniAktivumIndex >= 0 ? cellText(row[puvodniAktivumIndex]) : "";

    const cislo_zarizeni =
      extractEquipmentNumber(codeRaw) ??
      extractEquipmentNumber(aktivumRaw) ??
      (aktivumRaw || puvodniRaw || "");

    const termin = parseFlexibleDate(row[dateIndex]);
    const popis = cellText(row[assetDescIndex ?? fallbackDescIndex]) || codeRaw;
    const frekvenceRaw = frequencyIndex >= 0 ? row[frequencyIndex] : null;
    const frekvence =
      frekvenceRaw !== null && frekvenceRaw !== undefined && frekvenceRaw !== ""
        ? Number(frekvenceRaw)
        : null;
    const jednotky_frekvence = frequencyUnitIndex >= 0 ? cellText(row[frequencyUnitIndex]) : "";

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
