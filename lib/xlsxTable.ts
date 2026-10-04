import * as XLSX from "xlsx";

export type RawTable = {
  headers: string[];
  rows: unknown[][];
};

export function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Maximo (a jiné exporty) občas vygenerují ".xls", který je ve skutečnosti
 * HTML tabulka uložená s příponou .xls, nikoli skutečný binární/OOXML sešit.
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

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return "";
  return String(value)
    .replace(/ /g, " ")
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

/**
 * Přečte ".xls"/".xlsx" (skutečný binární/OOXML sešit i HTML tabulku
 * uloženou pod stejnou příponou, viz komentář výš) do poziční tabulky
 * (pole hlaviček + pole řádků buněk) – sdílené mezi importem plánu revizí
 * (lib/xlsxImport.ts) a importem ceníku (lib/xlsxCenik.ts), ať appka
 * detekci formátu a čtení souboru neduplikuje na dvou místech.
 */
export function readRawTable(data: ArrayBuffer): RawTable {
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
      "Soubor se nepodařilo přečíst jako Excel ani jako HTML tabulku. Zkontroluj, že jde o platný export (.xls/.xlsx), a zkus to nahrát znovu."
    );
  }
}
