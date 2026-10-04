import { parseFlexibleDate } from "@/lib/parseDate";
import type { ParseCenikResult, ParsedCenikPolozka } from "@/lib/pdfCenik";
import { cellText, normalizeHeader, readRawTable } from "@/lib/xlsxTable";

function isDeviceHeader(h: string): boolean {
  return /cislo.*zarizeni|zarizeni|^aktivum$|assetnum|^asset$|equipment/.test(h);
}

function isDescriptionHeader(h: string): boolean {
  return /popis|description|nazev/.test(h);
}

function isPriceHeader(h: string): boolean {
  return /cena/.test(h);
}

function isPriceTotalHeader(h: string): boolean {
  return isPriceHeader(h) && /celkem/.test(h);
}

function isNabidkaCisloHeader(h: string): boolean {
  return /cislo.*nabidk|nabidk.*cislo|^nabidka$/.test(h);
}

function isNabidkaDatumHeader(h: string): boolean {
  return /datum.*nabidk|nabidk.*datum/.test(h);
}

/**
 * Naparsuje cenu z buňky – appka v .xls/.xlsx narazí jak na skutečné číslo
 * (běžný číselný sloupec), tak na text ve tvaru "1 234 Kč" nebo "1234,50"
 * (export uložený jako text/HTML). Desetiny appka zaokrouhlí – stejně jako u
 * PDF nabídek appka počítá s cenou v celých korunách (viz parseCenaKc v
 * lib/pdfCenik.ts).
 */
function parseCena(value: unknown): number | null {
  if (typeof value === "number" && !isNaN(value)) return Math.round(value);
  if (typeof value !== "string") return null;
  const cislo = value.replace(/[^\d,.\-]/g, "").replace(",", ".");
  if (!cislo) return null;
  const n = Number(cislo);
  return isNaN(n) ? null : Math.round(n);
}

/**
 * Naparsuje ceník z .xls/.xlsx (skutečný sešit i HTML tabulka uložená pod
 * stejnou příponou, viz readRawTable v lib/xlsxTable.ts) – alternativa k
 * parseCenikPdf pro appku, která cenovou nabídku dostane jako tabulku, ne
 * jako PDF protokol. Očekává sloupce s číslem zařízení a cenou (název podle
 * záhlaví, ne podle pořadí – na rozdíl od parsePlanWorkbook v
 * lib/xlsxImport.ts tenhle export nemá známé duplicitní hlavičky, které by
 * mapování podle názvu znejasnily), volitelně popis a číslo/datum nabídky.
 * Číslo/datum nabídky appka bere z PRVNÍHO řádku, kde se najdou – v tomhle
 * exportu (na rozdíl od PDF, kde je nabídka jedna na soubor) můžou být
 * prázdné u všech řádků, pak zůstanou null (stejně jako PDF nabídka bez
 * rozpoznané hlavičky) a při srovnávání víc dávek (viz vyresitCenikSoubory)
 * mají nejnižší prioritu.
 */
export function parseCenikXlsx(data: ArrayBuffer): ParseCenikResult {
  const { headers, rows } = readRawTable(data);

  let cislo_nabidky: string | null = null;
  let datum_nabidky: Date | null = null;
  const polozky: ParsedCenikPolozka[] = [];

  if (headers.length === 0 || rows.length === 0) {
    return { cislo_nabidky, datum_nabidky, polozky };
  }

  const normalized = headers.map(normalizeHeader);
  const deviceIndex = normalized.findIndex(isDeviceHeader);
  const descIndex = normalized.findIndex(isDescriptionHeader);
  const priceTotalIndex = normalized.findIndex(isPriceTotalHeader);
  const priceIndex = priceTotalIndex >= 0 ? priceTotalIndex : normalized.findIndex(isPriceHeader);
  const nabidkaCisloIndex = normalized.findIndex(isNabidkaCisloHeader);
  const nabidkaDatumIndex = normalized.findIndex(isNabidkaDatumHeader);

  if (deviceIndex < 0 || priceIndex < 0) {
    throw new Error(
      "V souboru se nepodařilo najít sloupec s číslem zařízení a/nebo cenou. Zkontroluj hlavičky sloupců."
    );
  }

  rows.forEach((row, index) => {
    const cislo_zarizeni = cellText(row[deviceIndex]);
    const cena = parseCena(row[priceIndex]);
    // Řádky bez čísla zařízení nebo bez rozpoznatelné ceny appka přeskočí –
    // stejně jako u PDF (extractPolozka v lib/pdfCenik.ts) se nemají s čím
    // v appce spárovat.
    if (!cislo_zarizeni || cena === null) return;

    const popis = descIndex >= 0 ? cellText(row[descIndex]) : "";
    polozky.push({ cislo_zarizeni, popis, cena, stranka: index + 2 });

    if (cislo_nabidky === null && nabidkaCisloIndex >= 0) {
      const raw = cellText(row[nabidkaCisloIndex]);
      if (raw) cislo_nabidky = raw;
    }
    if (datum_nabidky === null && nabidkaDatumIndex >= 0) {
      const parsed = parseFlexibleDate(row[nabidkaDatumIndex]);
      if (parsed) datum_nabidky = parsed;
    }
  });

  return { cislo_nabidky, datum_nabidky, polozky };
}
