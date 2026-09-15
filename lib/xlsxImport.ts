import { parseFlexibleDate } from "@/lib/parseDate";
import { extractEquipmentNumber } from "@/lib/extractEquipmentNumber";
import { cellText, normalizeHeader, readRawTable } from "@/lib/xlsxTable";

export type ParsedPlanRow = {
  cislo_zarizeni: string;
  popis: string;
  /** null, pokud se v souboru nepodařilo rozpoznat/naparsovat termín – řádek se přesto uloží. */
  termin: Date | null;
  frekvence: number | null;
  jednotky_frekvence: string;
  /** Maximo PM číslo (sloupec "PÚ") – prázdné, pokud v souboru chybí. */
  pu: string;
};

export type ParseSkip = {
  row: number;
  reason: string;
};

export type ParsePlanResult = {
  rows: ParsedPlanRow[];
  skipped: ParseSkip[];
  /**
   * Řádky se sloupcem "Stav" = "INACTIVE" (case-insensitive, ořízlé) –
   * appka je při importu NEukládá/needituje. Volající (viz handleSave v
   * app/nahrat/page.tsx) navíc podle nich smaže odpovídající existující
   * záznam v "planovane_revize" (a jeho revizní zprávy), pokud v appce už
   * je – "ACTIVE" a "DRAFT" (nebo cokoli jiného než "INACTIVE") se
   * importují normálně, stejně jako doteď.
   */
  inactive: ParsedPlanRow[];
};

function isOriginalAssetHeader(h: string): boolean {
  return /puvodni.*aktiv/.test(h);
}

// Sloupec "PÚ" (Maximo PM číslo) – přirozený unikátní klíč jednoho řádku plánu,
// používá se jako Firestore ID záznamu, aby opakovaný import stejný řádek
// přepsal (aktuální termín), místo aby vytvořil duplicitní dokument.
function isPuHeader(h: string): boolean {
  return h === "pu";
}

// Sloupec s holým číslem/kódem zařízení ("Aktivum" apod.) – ne "Původní aktivum".
function isPlainAssetHeader(h: string): boolean {
  return /^aktivum$|^zarizeni$|assetnum|^asset$|equipment/.test(h) && !isOriginalAssetHeader(h);
}

// Sloupec "Stav" – appka podle jeho hodnoty rozlišuje aktivní zařízení
// ("ACTIVE"/"DRAFT", importují se normálně) od neaktivních ("INACTIVE").
function isStatusHeader(h: string): boolean {
  return h === "stav";
}

// Case-insensitive, ořízlé porovnání – "INACTIVE"/"inactive"/" Inactive " atd.
function isInactiveValue(raw: string): boolean {
  return raw.trim().toLowerCase() === "inactive";
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
  const inactive: ParsedPlanRow[] = [];

  if (headers.length === 0 || rawRows.length === 0) {
    return { rows, skipped, inactive };
  }

  const normalized = headers.map(normalizeHeader);

  const descIndices = normalized
    .map((h, i) => (isDescriptionHeader(h) ? i : -1))
    .filter((i) => i >= 0);
  const aktivumIndex = normalized.findIndex((h) => isPlainAssetHeader(h));
  const puvodniAktivumIndex = normalized.findIndex((h) => isOriginalAssetHeader(h));
  const puIndex = normalized.findIndex((h) => isPuHeader(h));
  const dateIndex = normalized.findIndex((h) => isDateHeader(h));
  const frequencyIndex = normalized.findIndex((h) => isFrequencyHeader(h));
  const frequencyUnitIndex = normalized.findIndex((h) => isFrequencyUnitHeader(h));
  const statusIndex = normalized.findIndex((h) => isStatusHeader(h));

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

    // V tomto exportu drží skutečné (revizní zprávou ověřitelné) číslo
    // zařízení sloupec "Původní aktivum", ne "Aktivum" – ten obsahuje jiný
    // interní kód. "Aktivum" proto slouží jen jako poslední záchranná
    // hodnota, kdyby "Původní aktivum" v souboru chybělo.
    const cislo_zarizeni =
      extractEquipmentNumber(codeRaw) ??
      extractEquipmentNumber(puvodniRaw) ??
      (puvodniRaw || aktivumRaw || "");

    const termin = parseFlexibleDate(row[dateIndex]);
    const popis = cellText(row[assetDescIndex ?? fallbackDescIndex]) || codeRaw;
    const frekvenceRaw = frequencyIndex >= 0 ? row[frequencyIndex] : null;
    const frekvence =
      frekvenceRaw !== null && frekvenceRaw !== undefined && frekvenceRaw !== ""
        ? Number(frekvenceRaw)
        : null;
    const jednotky_frekvence = frequencyUnitIndex >= 0 ? cellText(row[frequencyUnitIndex]) : "";
    const pu = puIndex >= 0 ? cellText(row[puIndex]) : "";
    const stavRaw = statusIndex >= 0 ? cellText(row[statusIndex]) : "";

    const parsedRow: ParsedPlanRow = {
      cislo_zarizeni,
      popis,
      termin,
      frekvence: frekvence !== null && !isNaN(frekvence) ? frekvence : null,
      jednotky_frekvence,
      pu,
    };

    // "INACTIVE" zařízení appka neimportuje vůbec – ani jako nový, ani jako
    // aktualizaci existujícího záznamu (ten navíc volající podle tohohle
    // pole rovnou smaže, viz handleSave). "ACTIVE"/"DRAFT" (nebo chybějící
    // sloupec "Stav") se importují normálně.
    if (statusIndex >= 0 && isInactiveValue(stavRaw)) {
      inactive.push(parsedRow);
      return;
    }

    // Chybějící termín (nebo jiný nerozpoznaný údaj) řádek nezahazuje – uloží se
    // s tím, co se podařilo přečíst, a označí se stavem "chybi_termin" při
    // zápisu do Firestore (viz handleSave v app/nahrat/page.tsx), ať uživatel
    // o žádná data z importu nepřijde. Přeskočí se jen řádek, kde se nepodařilo
    // rozpoznat vůbec nic (typicky prázdný/oddělovací řádek v exportu).
    const isCompletelyEmpty = !cislo_zarizeni && !popis && !pu && !termin && frekvence === null;
    if (isCompletelyEmpty) {
      skipped.push({ row: excelRowNumber, reason: "prázdný řádek" });
      return;
    }

    rows.push(parsedRow);
  });

  return { rows, skipped, inactive };
}
