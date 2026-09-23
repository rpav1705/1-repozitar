// "legacy" build (ne obyčejné "pdfjs-dist") záměrně – tenhle modul se
// nepoužívá jen z prohlížeče (viz app/nahrat/page.tsx), ale i ze samostatného
// Node skriptu scripts/reprocess-all-revizni-zpravy.ts. Obyčejný "pdfjs-dist"
// build v Node spadne hned při importu (spoléhá na Uint8Array.prototype.toHex,
// které starší/aktuální Node nemusí mít) – "legacy" build je Mozillou určený
// přesně pro tuhle univerzální kompatibilitu (starší prohlížeče i Node/server)
// a funguje beze změny v obou prostředích.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseFlexibleDate } from "./parseDate";
import { yieldToMainThread } from "./yieldToMainThread";

/**
 * Klasifikace "celkove_hodnoceni" do tří stavů – appka nikdy nemá jistě
 * vědět, že je zpráva v pořádku, pokud text přesně neodpovídá očekávané
 * formulaci. "KE_KONTROLE" proto pokrývá jak nerozpoznanou/neznámou
 * formulaci (např. "Vyhovuje s omezením" dle ČSN 33 1600 ed.2), tak úplně
 * chybějící pole – ať se to nikdy tiše nezamíchá mezi OK, ani mezi NOK.
 */
export type VysledekRevize = "OK" | "NOK" | "KE_KONTROLE";

export type ParsedRevizniZprava = {
  cislo_zarizeni: string;
  datum_provedeni: Date;
  novy_termin: Date;
  /** "Vyhovuje" / "Nevyhovuje" apod. – prázdné, pokud se nepodařilo rozpoznat. */
  celkove_hodnoceni: string;
  /** Klasifikace celkove_hodnoceni – viz typ VysledekRevize. */
  vysledek_revize: VysledekRevize;
  /**
   * Text z pole "Zjištěná závada/poznámka:" – null, pokud je pole prázdné
   * (typicky u zpráv s výsledkem "Vyhovuje") nebo se nepodařilo najít.
   * Appka zatím ověřila jen šablonu "spotrebic" (viz
   * extractZjistenaZavadaSpotrebic) a jen na zprávě s prázdným polem –
   * skutečný formát vyplněného pole (víceřádkový text u NOK zprávy) zatím
   * nebyl k dispozici, takže se může upřesnit, až se objeví reálný příklad.
   */
  zjistena_zavada: string | null;
  /** Jméno revizního technika – null, pokud se nepodařilo rozpoznat (nekritické pole). */
  technik_jmeno: string | null;
  /** Evidenční číslo oprávnění revizního technika – null, pokud se nepodařilo rozpoznat. */
  technik_cislo_opravneni: string | null;
  /** 1-based číslo stránky uvnitř nahraného PDF. */
  stranka: number;
};

/**
 * Přesná shoda "vyhovuje" (case-insensitive, ořízlé) → OK. Text OBSAHUJÍCÍ
 * "nevyhovuje" → NOK (kontrola na přesnou shodu s "vyhovuje" musí být PRVNÍ,
 * jinak by "nevyhovuje" jako podřetězec obsahující "vyhovuje" vyšlo jako OK).
 * Cokoli jiného (jiná formulace, nebo prázdné/nenalezené pole) → KE_KONTROLE.
 */
function klasifikujVysledekRevize(celkoveHodnoceni: string): VysledekRevize {
  const text = celkoveHodnoceni.trim().toLowerCase();
  if (text === "vyhovuje") return "OK";
  if (text.includes("nevyhovuje")) return "NOK";
  return "KE_KONTROLE";
}

export type SkippedPage = {
  stranka: number;
  duvod: string;
};

export type ParseRevizniZpravyResult = {
  zpravy: ParsedRevizniZprava[];
  preskoceno: SkippedPage[];
};

// pdf.worker.min.mjs v /public je zkopírovaný přímo z nainstalované verze
// pdfjs-dist (node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs) – API a
// worker verze musí přesně sedět, jinak pdf.js odmítne dokument otevřít. Při
// update balíčku pdfjs-dist je potřeba worker soubor v /public zkopírovat
// znovu (ze stejné "legacy" varianty, viz import pdfjsLib výš).
//
// V Node (scripts/reprocess-all-revizni-zpravy.ts) žádný /pdf.worker.min.mjs
// server neběží – worker soubor se tam najde přímo v node_modules. "node:module"
// se importuje dynamicky (ne staticky nahoře v souboru), ať Next.js tenhle
// Node-only kód vůbec nemusí řešit při sestavování klientského bundlu pro
// prohlížeč (ta větev se za běhu v prohlížeči nikdy nespustí).
let workerConfigured = false;
async function ensureWorker() {
  if (workerConfigured) return;
  if (typeof window !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  } else {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs"
    );
  }
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
// Date.UTC(), NE "new Date(rok, měsíc, den)" – viz vysvětlení u
// parseFlexibleDate v lib/parseDate.ts (appka běží v prohlížeči i v Node
// skriptu s různou časovou zónou, obyčejný Date konstruktor bez UTC by pro
// stejné datum dal v každém prostředí jiný Timestamp).
function lastDayOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

/** "1/27", "01/27" i "1/2027" (měsíc/rok, dvou- i čtyřciferný) -> poslední den daného měsíce. */
function parseMesicRok(raw: string): Date | null {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{2,4})/);
  if (!match) return null;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return null;
  const yearRaw = match[2];
  const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
  return lastDayOfMonth(year, month);
}

/**
 * Společný parser hodnoty termínu příští revize pro obě šablony – zkusí
 * postupně přesné datum, český název měsíce + rok a zkrácený číselný formát
 * měsíc/rok (dvou- i čtyřciferný rok).
 */
function parseTerminHodnota(raw: string): Date | null {
  const text = raw.trim();

  const exact = parseFlexibleDate(text);
  if (exact) return exact;

  const monthNameMatch = text.match(/^(\p{L}+)\s+(\d{4})/u);
  if (monthNameMatch) {
    const month = CZECH_MONTHS[monthNameMatch[1].toLowerCase()];
    const year = Number(monthNameMatch[2]);
    if (month) return lastDayOfMonth(year, month);
  }

  return parseMesicRok(text);
}

// ---------------------------------------------------------------------------
// Šablona A: "Protokol o pravidelné revizi elektrického spotřebiče"
// (program ILLKO Studio, dle ČSN 33 1600 ed.2).
// ---------------------------------------------------------------------------

/**
 * Hodnota "Inventárního čísla" je jeden sloupec reconstructLines výstupu –
 * sloupce jsou odděleny 2+ mezerami (viz join("  ") tamtéž). Původní
 * "(\S+)" ořízl hodnotu na PRVNÍ mezeře i uvnitř jednoho sloupce, což mělo
 * dva různé (a navzájem opačné) reálné dopady:
 *   - u kódu rozděleného mezerou překlepem ("ASST 133", "BLUE 01") uřízl
 *     druhou půlku úplně – kód se pak vůbec nespároval s plánem.
 *   - u popisného dvouslovného kódu ("čistici box") uřízl druhé slovo.
 * Nová hodnota proto přeskočí JEDNU mezeru (ne 2+, to už je hranice dalšího
 * sloupce), ale JEN pokud za ní hned následuje písmeno/číslice – to
 * spolehlivě odliší pokračování stejného kódu od PŘÍPONY/odkazu na jiné
 * zařízení začínající symbolem ("FOAM05 / Z01", "ASST96 + ASST97" – tam se
 * záměrně zastaví hned na "FOAM05"/"ASST96", stejně jako předtím, protože
 * "planovane_revize" vede jen tu první část jako vlastní číslo zařízení).
 * Zachycená mezera uvnitř výsledného kódu se pak odstraní – viz komentář u
 * .replace(/\s+/g, "") níž.
 */
const INVENTARNI_CISLO_SPOTREBIC_RE =
  /Inventární\s*číslo:\s*([^\s]+(?:\s(?!\s)(?=[\p{L}\p{N}])[^\s]+)*)/u;

function extractInventarniCisloSpotrebic(lines: string[]): string | null {
  const hodnota = findValueAfterLabel(lines, INVENTARNI_CISLO_SPOTREBIC_RE);
  // Mezera zachycená uvnitř kódu zařízení (viz regex výš – nastane jen u
  // překlepu typu "ASST 133") se u téhle šablony v "planovane_revize" nikde
  // nevyskytuje (ověřeno ručně na reálných PDF – viz diagnostika
  // nesparovaných zpráv) – odstraní se, ať se kód přesně shoduje s plánem.
  return hodnota ? hodnota.replace(/\s+/g, "") : null;
}

function extractDatumProvedeniSpotrebic(lines: string[]): Date | null {
  const raw = findValueAfterLabel(lines, /Revize byla provedena dne:\s*(\d{1,2}\.\d{1,2}\.\d{4})/);
  return raw ? parseFlexibleDate(raw) : null;
}

function extractTerminSpotrebic(lines: string[]): Date | null {
  const raw = findValueAfterLabel(lines, /Řádný termín příští revize je nejpozději do:\s*(.+)/);
  return raw ? parseTerminHodnota(raw) : null;
}

/**
 * Jméno technika je na řádku HNED POD popiskem "Revizi provedl a protokol
 * vystavil:" – v pravém sloupci (vlevo na tom řádku bývá adresa dodavatele,
 * ta k technikovi nepatří). Řádek rozdělíme podle 2+ mezer (tak jsou sloupce
 * oddělené i po reconstructLines) a vezmeme poslední neprázdný sloupec.
 */
function extractTechnikJmenoSpotrebic(lines: string[]): string | null {
  const idx = lines.findIndex((l) => /Revizi provedl a protokol vystavil:/.test(l));
  const nextLine = idx !== -1 ? lines[idx + 1] : undefined;
  if (!nextLine) return null;
  const columns = nextLine.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
  return columns.length > 0 ? columns[columns.length - 1] : null;
}

/**
 * Číslo oprávnění bývá na řádku s "Ev. číslo:" – hodnota samotná je uvedená
 * za posledním výskytem "č.:" (v ukázce zdvojeně "Ev. číslo: ev.č.: ...").
 * Když se "č.:" na řádku nenajde, zkusíme jako zálohu text přímo za "Ev. číslo:".
 */
function extractCisloOpravneniSpotrebic(lines: string[]): string | null {
  const line = lines.find((l) => /Ev\.?\s*číslo\s*:/i.test(l));
  if (!line) return null;

  const markerIdx = line.lastIndexOf("č.:");
  if (markerIdx !== -1) {
    const value = line.slice(markerIdx + "č.:".length).trim();
    if (value) return value;
  }

  return findValueAfterLabel([line], /Ev\.?\s*číslo\s*:\s*(.+)/i);
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

/**
 * "Zjištěná závada/poznámka:" je ve spodní části stránky mezi popisnou
 * sekcí "Výsledek revize:" a řádkem "Revize byla provedena dne:". Na
 * ověřené (OK) zprávě je pole prázdné – za popiskem už nic není a hned
 * následuje další popisek. Hodnota se tedy bere jako text za popiskem na
 * stejném řádku, případně (kdyby dlouhá závada přetékala na další řádky)
 * všechno až do řádku "Revize byla provedena dne:" – to ale zatím nebylo
 * možné ověřit na žádné reálné NOK zprávě.
 */
function extractZjistenaZavadaSpotrebic(lines: string[]): string | null {
  const idx = lines.findIndex((l) => /Zjištěná\s*závada\s*\/?\s*poznámka\s*:/i.test(l));
  if (idx === -1) return null;

  const afterLabel = lines[idx].split(/Zjištěná\s*závada\s*\/?\s*poznámka\s*:/i)[1]?.trim() ?? "";
  const parts = afterLabel ? [afterLabel] : [];

  for (let i = idx + 1; i < lines.length; i++) {
    if (/Revize byla provedena dne:/.test(lines[i])) break;
    const text = lines[i].trim();
    if (text) parts.push(text);
  }

  const zavada = parts.join(" ").trim();
  return zavada.length > 0 ? zavada : null;
}

function extractSpotrebicZprava(lines: string[]) {
  const celkove_hodnoceni = extractCelkoveHodnoceniSpotrebic(lines);
  return {
    cislo_zarizeni: extractInventarniCisloSpotrebic(lines),
    datum_provedeni: extractDatumProvedeniSpotrebic(lines),
    novy_termin: extractTerminSpotrebic(lines),
    celkove_hodnoceni,
    vysledek_revize: klasifikujVysledekRevize(celkove_hodnoceni),
    zjistena_zavada: extractZjistenaZavadaSpotrebic(lines),
    technik_jmeno: extractTechnikJmenoSpotrebic(lines),
    technik_cislo_opravneni: extractCisloOpravneniSpotrebic(lines),
  };
}

// ---------------------------------------------------------------------------
// Šablona B: "Zpráva o revizi elektrického zařízení pracovního stroje"
// (dle ČSN EN 60204-1) – jiná revizní firma/formulář, ověřeno na reálné
// zprávě "165022 1-2026.pdf".
// ---------------------------------------------------------------------------

/**
 * Popisek bez dvojtečky, hodnota má často prefix "EAN:" (např. "EAN: 165022").
 * U některých souborů (poškozený font v PDF – stejný symptom jako "TT:
 * undefined function" varování z pdf.js na těchhle souborech) tenhle prefix
 * ztratí úvodní písmena a v textu zůstane jen "AN:" nebo "N:" – "(?:\S*:\s*)?"
 * proto skipne jakýkoli takhle useknutý "*:"-prefix, ne jen doslovné "EAN:".
 * Zachycení hodnoty samotné pak zrcadlí INVENTARNI_CISLO_SPOTREBIC_RE výš
 * (sloupec končí až na 2+ mezerách/konci řádku, ne na první mezeře) – viz
 * komentář tam.
 */
const INVENTARNI_CISLO_STROJ_RE =
  /Inventární\s*číslo\s*:?\s*(?:\S*:\s*)?([^\s]+(?:\s(?!\s)(?=[\p{L}\p{N}])[^\s]+)*)/u;

function extractInventarniCisloStroj(lines: string[]): string | null {
  const hodnota = findValueAfterLabel(lines, INVENTARNI_CISLO_STROJ_RE);
  // Viz komentář u stejného .replace() v extractInventarniCisloSpotrebic výš.
  return hodnota ? hodnota.replace(/\s+/g, "") : null;
}

/** "17. leden 2026" -> den 17, měsíc leden, rok 2026 (nesklonný název měsíce). */
function parseDenMesicRok(raw: string): Date | null {
  const match = raw.trim().match(/^(\d{1,2})\.\s*(\p{L}+)\s+(\d{4})/u);
  if (!match) return null;
  const day = Number(match[1]);
  const month = CZECH_MONTHS[match[2].toLowerCase()];
  const year = Number(match[3]);
  if (!month) return null;
  // Date.UTC() – viz vysvětlení u parseFlexibleDate v lib/parseDate.ts.
  const date = new Date(Date.UTC(year, month - 1, day));
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

function extractTerminStroj(lines: string[]): Date | null {
  const raw = findValueAfterLabel(lines, /Stanovení termínu další revize:\s*(.+)/);
  return raw ? parseTerminHodnota(raw) : null;
}

/**
 * Jméno technika i číslo oprávnění jsou tu jednoduché popisky přímo na řádku
 * (na rozdíl od šablony A) – "- jméno:  David Kadlec  Datum revize:" a
 * "- ev. číslo:  2578/24/R-EZ-E1A,E1B" na řádku pod ním. Jméno končí buď
 * 2+ mezerami (další sloupec / popisek), nebo koncem řádku.
 */
function extractTechnikJmenoStroj(lines: string[]): string | null {
  return findValueAfterLabel(lines, /-\s*jméno:\s*([^\s]+(?:\s[^\s]+)*?)(?:\s{2,}|$)/);
}

function extractCisloOpravneniStroj(lines: string[]): string | null {
  return findValueAfterLabel(lines, /-\s*ev\.\s*číslo:\s*(.+)/);
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

/**
 * "Celkový posudek:" (viz extractPosudekStroj výš) je vždycky stejná úvodní
 * prózová věta ("Revidované zařízení je z hlediska bezpečnosti schopno
 * provozu při dodržení podmínek uvedených...") – NIKDY neobsahuje doslova
 * "vyhovuje"/"nevyhovuje", takže z něj nejde (na rozdíl od šablony A)
 * odvodit OK/NOK. Skutečný výsledek je dál na stránce v sekci
 * "B.  Kontroly (ČSN EN 60204-1 ed.3, čl. 18.6 a 18.7)" – čtyři dílčí
 * kontroly (funkce tlačítka STOP, nouzové zastavení, nastavení proudových
 * relé, kontrola rozběhu stroje po ztrátě napětí a jeho obnovení), každá
 * zakončená "vyhovuje"/"nevyhovuje" – a v tabulce "Zjištěné závady" pod ní
 * (sloupce Číslo / Zjištěné závady / Termín odstranění, končí řádkem
 * "Stanovení termínu další revize:"). Ověřeno na 101 reálných zprávách (byly
 * dřív mylně KE_KONTROLE) – všech 101 mělo identickou strukturu a prázdnou
 * tabulku, žádná neměla "nevyhovuje", takže se korektně vyhodnotí jako OK;
 * skutečnou NOK zprávu s vyplněnou tabulkou appka zatím neviděla, format
 * textu závady se tak může upřesnit, až se nějaká objeví.
 */
function extractVysledekKontrolStroj(
  lines: string[]
): { vysledek_revize: VysledekRevize; zjistena_zavada: string | null } | null {
  const kontrolyIdx = lines.findIndex((l) => /^B\.\s*Kontroly\b/.test(l));
  if (kontrolyIdx === -1) return null;

  const tabulkaIdx = lines.findIndex(
    (l, i) => i > kontrolyIdx && /Číslo\s+Zjištěné\s+závady\s+Termín\s+odstranění/i.test(l)
  );
  if (tabulkaIdx === -1) return null;

  const terminIdx = lines.findIndex(
    (l, i) => i > tabulkaIdx && /Stanovení termínu další revize:/.test(l)
  );

  const kontrolyRadky = lines.slice(kontrolyIdx + 1, tabulkaIdx);
  const nejakaNevyhovuje = kontrolyRadky.some((l) => /nevyhovuje/i.test(l));

  const zavadaRadky = (terminIdx === -1 ? lines.slice(tabulkaIdx + 1) : lines.slice(tabulkaIdx + 1, terminIdx))
    .map((l) => l.trim())
    .filter(Boolean);
  const zavadaText = zavadaRadky.join(" ").trim();

  if (nejakaNevyhovuje || zavadaText.length > 0) {
    return {
      vysledek_revize: "NOK",
      zjistena_zavada:
        zavadaText.length > 0
          ? zavadaText
          : "dílčí kontrola v sekci \"B. Kontroly\" neuvádí \"vyhovuje\"",
    };
  }

  return { vysledek_revize: "OK", zjistena_zavada: null };
}

function extractStrojZprava(lines: string[]) {
  const kontroly = extractVysledekKontrolStroj(lines);
  return {
    cislo_zarizeni: extractInventarniCisloStroj(lines),
    datum_provedeni: extractDatumProvedeniStroj(lines),
    novy_termin: extractTerminStroj(lines),
    celkove_hodnoceni: extractPosudekStroj(lines),
    // Sekce "B. Kontroly" + tabulka "Zjištěné závady" se nenajde jen u
    // úplně jiné (třetí, zatím neznámé) varianty šablony – appka v tom
    // případě zůstane u KE_KONTROLE stejně jako dosud (viz
    // extractVysledekKontrolStroj).
    vysledek_revize: kontroly?.vysledek_revize ?? ("KE_KONTROLE" as VysledekRevize),
    zjistena_zavada: kontroly?.zjistena_zavada ?? null,
    technik_jmeno: extractTechnikJmenoStroj(lines),
    technik_cislo_opravneni: extractCisloOpravneniStroj(lines),
  };
}

// ---------------------------------------------------------------------------
// Šablona C: "Zpráva o revizi elektrického zařízení" (dle ČSN 33 1500,
// ČSN 33 2000-6 ed.2) – obecná revize elektrické instalace/rozvaděče (ne
// jednotlivý spotřebič ani pracovní stroj), ověřeno na reálné zprávě
// "DATAPLC01-2026.pdf". Na rozdíl od šablon A a B je tahle zpráva vždycky
// rozdělená na VÍC STRÁNEK (typicky 3) – stránka 1 nese hlavičku (evidenční
// číslo, data, technika, termín), stránka 2 popisné body 5–13 včetně sekce
// "13, ZÁVADY", stránka 3 tabulku měření. Volající (parseRevizniZpravyPdf)
// proto pro tuhle šablonu spojí řádky NÁSLEDUJÍCÍCH stránek (podle počtu z
// "Tato zpráva má: N stran") do jedné sady, než zavolá extrakci níž – na
// rozdíl od šablon A/B, kde je vždycky jedna zpráva = jedna stránka.
// ---------------------------------------------------------------------------

/**
 * "Revize ev. č. DATAPLC01-2026" – appka jako číslo zařízení bere kód PŘED
 * koncovou pomlčkou a rokem (ten se mění revizi od revize, samotné zařízení
 * ne). Bez rozpoznaného roku (neobvyklý formát evidenčního čísla) se použije
 * celý zachycený kód beze změny, ať appka radši zkusí spárovat s plánem
 * "syrový" kód než revizní zprávu rovnou přeskočit.
 */
function extractCisloZarizeniZarizeni(lines: string[]): string | null {
  const raw = findValueAfterLabel(lines, /Revize\s+ev\.\s*č\.?\s*([^\s]+)/i);
  return raw ? raw.replace(/-\d{4}$/, "") : null;
}

function extractDatumProvedeniZarizeni(lines: string[]): Date | null {
  const raw =
    findValueAfterLabel(lines, /Datum\s+ukončení\s+revize:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i) ??
    findValueAfterLabel(lines, /Datum\s+zahájení\s+revize:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
  return raw ? parseFlexibleDate(raw) : null;
}

function extractTerminZarizeni(lines: string[]): Date | null {
  const raw = findValueAfterLabel(lines, /Doporučený\s+termín\s+další\s+revize:\s*(.+)/i);
  return raw ? parseTerminHodnota(raw) : null;
}

/**
 * "Jméno:  David Kadlec, Rušinov 1, Rušinov" – jméno je jen první část před
 * první čárkou, zbytek je adresa technika. Stejný popisek "Jméno:" se na
 * zprávě objevuje ještě jednou dole u nevyplněného razítka "Revizní zprávu
 * převzal:" (jen tečkovaná čára bez čárky) – findValueAfterLabel vrací PRVNÍ
 * shodu v pořadí řádků, tedy tu u revizního technika nahoře na stránce.
 */
function extractTechnikJmenoZarizeni(lines: string[]): string | null {
  const raw = findValueAfterLabel(lines, /Jméno:\s*([^,]+)/i);
  return raw ? raw.trim() : null;
}

function extractCisloOpravneniZarizeni(lines: string[]): string | null {
  return findValueAfterLabel(lines, /Ev\.\s*číslo:\s*(.+)/i);
}

/**
 * "Celkový posudek:" je tu (na rozdíl od jednoslovné hodnoty v šabloně A)
 * taky celý odstavec prózy jako v šabloně B, navíc na VLASTNÍM řádku bez
 * textu za dvojtečkou – skutečná věta začíná až na řádku pod popiskem.
 * Zkusí tedy nejdřív stejný řádek (kdyby byl formát někdy jednořádkový),
 * jinak vezme řádek hned pod popiskem.
 */
function extractPosudekZarizeni(lines: string[]): string {
  const idx = lines.findIndex((l) => /Celkový posudek:/i.test(l));
  if (idx === -1) return "";
  const sameLine = lines[idx].split(/Celkový posudek:/i)[1]?.trim();
  if (sameLine) return sameLine;
  return lines[idx + 1]?.trim() ?? "";
}

/**
 * Výsledek revize se u téhle šablony (stejně jako u šablony B) NEDÁ poznat
 * z "Celkový posudek:" – to je vždycky stejná pozitivní úvodní věta bez ohledu
 * na skutečný nález. Skutečný výsledek je až v sekci "13, ZÁVADY" (poslední
 * bod zprávy, na stránce 2 ze 3) – prázdná/žádná závada se popisuje frází
 * "bez zjevných závad" (ověřeno na reálné zprávě). Cokoli jiného v sekci
 * appka bere jako text nalezené závady a klasifikuje jako NOK; když se sekce
 * vůbec nenajde (jiná varianta šablony), zůstává KE_KONTROLE stejně jako u
 * ostatních šablon při nejistotě.
 */
function extractVysledekZavadZarizeni(
  lines: string[]
): { vysledek_revize: VysledekRevize; zjistena_zavada: string | null } {
  const idx = lines.findIndex((l) => /^13\s*,\s*ZÁVADY/i.test(l.trim()));
  if (idx === -1) return { vysledek_revize: "KE_KONTROLE", zjistena_zavada: null };

  // Sekce končí buď dalším číslovaným bodem ("14, ..."), nebo koncem stránky.
  const dalsiBodIdx = lines.findIndex((l, i) => i > idx && /^\d+\s*,\s*\S/.test(l.trim()));
  const obsahRadky = (dalsiBodIdx === -1 ? lines.slice(idx + 1) : lines.slice(idx + 1, dalsiBodIdx))
    .map((l) => l.trim())
    .filter(Boolean);
  const text = obsahRadky.join(" ").trim();

  if (/^bez\s+(zjevných\s+)?závad/i.test(text)) {
    return { vysledek_revize: "OK", zjistena_zavada: null };
  }
  if (text.length > 0) {
    return { vysledek_revize: "NOK", zjistena_zavada: text };
  }
  return { vysledek_revize: "KE_KONTROLE", zjistena_zavada: null };
}

/**
 * Druhá a další stránka téhle šablony opakuje v záhlaví/patičce jméno
 * technika, číslo revize a číslo stránky ("Revizní technik: David Kadlec
 * č. revize: DATAPLC01-2026", "Stránka 2 z 3") – appka tyhle řádky při
 * spojování stránek (viz parseRevizniZpravyPdf) odfiltruje, ať se omylem
 * nepřimíchají do obsahu sekce "13, ZÁVADY" (ta by jinak u vícestránkového
 * spojení mohla sahat až přes hranici stránky, protože číslované body 5–13
 * jsou celé na stránce 2, ale "14, Výsledky měření" už začíná na stránce 3
 * ZA touhle opakovanou hlavičkou).
 */
function jeOpakovanaHlavickaZarizeni(line: string): boolean {
  const t = line.trim();
  return /^Revizní\s+technik:.*č\.\s*revize:/i.test(t) || /^Stránka\s+\d+\s+z\s+\d+$/i.test(t);
}

/** "Tato zpráva má:  3 strany" – kolik stránek PDF dohromady tvoří tuhle jednu revizní zprávu. */
function extractPocetStranZarizeni(lines: string[]): number | null {
  const raw = findValueAfterLabel(lines, /Tato\s+zpráva\s+má:\s*(\d+)\s*stran/i);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractZarizeniZprava(lines: string[]) {
  const { vysledek_revize, zjistena_zavada } = extractVysledekZavadZarizeni(lines);
  return {
    cislo_zarizeni: extractCisloZarizeniZarizeni(lines),
    datum_provedeni: extractDatumProvedeniZarizeni(lines),
    novy_termin: extractTerminZarizeni(lines),
    celkove_hodnoceni: extractPosudekZarizeni(lines),
    vysledek_revize,
    zjistena_zavada,
    technik_jmeno: extractTechnikJmenoZarizeni(lines),
    technik_cislo_opravneni: extractCisloOpravneniZarizeni(lines),
  };
}

// ---------------------------------------------------------------------------

type Sablona = "spotrebic" | "pracovni_stroj" | "elektricke_zarizeni";

/** Podle nadpisu na stránce pozná, kterou ze tří známých šablon použít. */
function detectSablona(lines: string[]): Sablona | null {
  const text = lines.join("\n");
  if (/revizi elektrického zařízení pracovního stroje/.test(text)) return "pracovni_stroj";
  if (/revizi elektrického spotřebiče/.test(text)) return "spotrebic";
  // Case-insensitive a samostatně (na rozdíl od šablon výš) – nadpis "ZPRÁVA
  // O REVIZI ELEKTRICKÉHO ZAŘÍZENÍ" je na reálné zprávě celý velkými písmeny.
  // Kontrola "pracovního stroje" výš proběhne vždycky první (viz pořadí
  // if větví), takže se šablony nemůžou splést i přes společný podřetězec
  // "elektrického zařízení".
  if (/zpráva\s+o\s+revizi\s+elektrického\s+zařízení\b/i.test(text)) return "elektricke_zarizeni";
  return null;
}

/**
 * Naparsuje jednu nebo víc revizních zpráv z PDF. Šablony A a B (spotřebič,
 * pracovní stroj) mají vždycky jednu zprávu na JEDNU stránku – appka je tak
 * prochází stránku po stránce (jeden nahraný soubor může obsahovat revizní
 * zprávy pro víc zařízení, jednu na stránku). Šablona C (obecné elektrické
 * zařízení) naopak zabírá VÍC stránek na jednu zprávu (viz komentář u ní
 * výš) – appka po jejím rozpoznání spojí řádky odpovídajícího počtu
 * následujících stránek (dle "Tato zpráva má: N stran") a pokračuje AŽ ZA
 * nimi, ať appka zbylé stránky téže zprávy znovu nezkoušela rozpoznat jako
 * samostatné (a nesprávně přeskočené) zprávy. Číslo zařízení a všechny
 * ostatní údaje se čtou výhradně z textového obsahu PDF, nikdy z názvu
 * souboru. Podporuje tři reálně ověřené šablony revizních zpráv (viz
 * detectSablona výše) a stránky neodpovídající žádné z nich přeskočí se
 * srozumitelným důvodem.
 */
export async function parseRevizniZpravyPdf(data: ArrayBuffer): Promise<ParseRevizniZpravyResult> {
  await ensureWorker();

  // getDocument() převezme vlastnictví předaného ArrayBufferu a přesune ho
  // (detached) do web workeru – jakékoli další použití originálu (např. upload
  // téhož souboru do Firebase Storage volajícím kódem) by pak spadlo na
  // "Cannot perform Construct on a detached ArrayBuffer". Voláme proto na
  // nezávislé kopii, ať buffer volajícího zůstane použitelný i po návratu.
  // KRITICKÉ: getDocument() bez explicitního "worker" parametru si při KAŽDÉM
  // volání vytvoří VLASTNÍ nový PDFWorker (v prohlížeči = nové vlákno Web
  // Workeru se svou vlastní JS haldou, viz PDFWorker.create() v pdf.mjs) a ten
  // worker (spolu s dekódovanými daty stránek/fontů, které si drží) se uvolní
  // JEN voláním loadingTask.destroy() – appka ho dřív nikde nevolala (destroy
  // je na "loading tasku" vráceném ze samotného getDocument(), NE na
  // vyřešeném PDFDocumentProxy z .promise). U dávek stovek až tisíc souborů
  // (typicky přes RevizniZpravyReprocess) tak appce v paměti zůstávaly viset
  // stovky až tisíce nikdy neuklizených workerů = reálně pozorovaný růst
  // spotřeby paměti karty do jednotek GB. finally zajistí úklid i když
  // parsování/getPage někde uprostřed spadne.
  const loadingTask = pdfjsLib.getDocument({ data: data.slice(0) });
  try {
    const doc = await loadingTask.promise;
    const zpravy: ParsedRevizniZprava[] = [];
    const preskoceno: SkippedPage[] = [];

    let stranka = 1;
    while (stranka <= doc.numPages) {
      // getPage/getTextContent samotné běží ve web workeru pdf.js (mimo hlavní
      // vlákno), ale reconstructLines/regexové extrakce níž už běží tady na
      // hlavním vlákně appky – u souboru s hodně stránkami (víc revizních zpráv
      // v jednom PDF, jedna na stránku) by se bez týhle pauzy mohly zřetězit
      // za sebou bez jediné šance na vykreslení/uživatelský vstup.
      if (stranka > 1 && stranka % 5 === 0) {
        await yieldToMainThread();
      }

      const page = await doc.getPage(stranka);
      const content = await page.getTextContent();
      const lines = reconstructLines(content.items);

      const sablona = detectSablona(lines);
      if (!sablona) {
        // Náhled skutečně přečteného textu (ne jen "nerozpoznáno") – u nové
        // varianty šablony (nebo PDF s poškozeným/nekompatibilním fontem,
        // kdy pdf.js přečte jiný text, než jaký je vidět při otevření
        // souboru) appka bez tohohle náhledu nedá poznat, PROČ detekce
        // selhala, a je potřeba hádat naslepo.
        const nahled = lines.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
        preskoceno.push({
          stranka,
          duvod: `nerozpoznaný typ revizní zprávy (začátek stránky: "${nahled}")`,
        });
        stranka += 1;
        continue;
      }

      if (sablona === "elektricke_zarizeni") {
        // Víc stránek jedné zprávy (viz komentář u šablony C výš) – řádky
        // dalších stránek se přidají k téhle první, než se zavolá extrakce,
        // a appka pak přeskočí rovnou ZA poslední z nich (viz stranka +=
        // pocetStran níž), ať se zbylé stránky nezkoušely rozpoznat znovu
        // samostatně.
        const pocetStran = extractPocetStranZarizeni(lines) ?? 1;
        const vsechnyRadky = [...lines];
        for (let i = 1; i < pocetStran && stranka + i <= doc.numPages; i++) {
          const dalsiPage = await doc.getPage(stranka + i);
          const dalsiContent = await dalsiPage.getTextContent();
          // Viz komentář u jeOpakovanaHlavickaZarizeni – opakovaná
          // hlavička/patička dalších stránek se do spojených řádků vůbec
          // nezahrne, ať se nepřimíchá do obsahu žádné extrahované sekce.
          vsechnyRadky.push(
            ...reconstructLines(dalsiContent.items).filter((l) => !jeOpakovanaHlavickaZarizeni(l))
          );
        }

        const extracted = extractZarizeniZprava(vsechnyRadky);

        if (!extracted.cislo_zarizeni) {
          preskoceno.push({
            stranka,
            duvod: "nepodařilo se najít evidenční číslo revize (šablona: elektrické zařízení)",
          });
          stranka += pocetStran;
          continue;
        }
        if (!extracted.datum_provedeni) {
          preskoceno.push({
            stranka,
            duvod: "nepodařilo se najít datum provedení revize (šablona: elektrické zařízení)",
          });
          stranka += pocetStran;
          continue;
        }
        if (!extracted.novy_termin) {
          preskoceno.push({
            stranka,
            duvod: "nepodařilo se rozpoznat termín příští revize (šablona: elektrické zařízení)",
          });
          stranka += pocetStran;
          continue;
        }

        zpravy.push({
          cislo_zarizeni: extracted.cislo_zarizeni,
          datum_provedeni: extracted.datum_provedeni,
          novy_termin: extracted.novy_termin,
          celkove_hodnoceni: extracted.celkove_hodnoceni,
          vysledek_revize: extracted.vysledek_revize,
          zjistena_zavada: extracted.zjistena_zavada,
          technik_jmeno: extracted.technik_jmeno,
          technik_cislo_opravneni: extracted.technik_cislo_opravneni,
          stranka,
        });
        stranka += pocetStran;
        continue;
      }

      const extracted = sablona === "spotrebic" ? extractSpotrebicZprava(lines) : extractStrojZprava(lines);
      const sablonaPopis = sablona === "spotrebic" ? "spotřebič" : "pracovní stroj";

      if (!extracted.cislo_zarizeni) {
        preskoceno.push({ stranka, duvod: `nepodařilo se najít Inventární číslo (šablona: ${sablonaPopis})` });
        stranka += 1;
        continue;
      }

      if (!extracted.datum_provedeni) {
        preskoceno.push({ stranka, duvod: `nepodařilo se najít datum provedení revize (šablona: ${sablonaPopis})` });
        stranka += 1;
        continue;
      }

      if (!extracted.novy_termin) {
        preskoceno.push({ stranka, duvod: `nepodařilo se rozpoznat termín příští revize (šablona: ${sablonaPopis})` });
        stranka += 1;
        continue;
      }

      zpravy.push({
        cislo_zarizeni: extracted.cislo_zarizeni,
        datum_provedeni: extracted.datum_provedeni,
        novy_termin: extracted.novy_termin,
        celkove_hodnoceni: extracted.celkove_hodnoceni,
        vysledek_revize: extracted.vysledek_revize,
        zjistena_zavada: extracted.zjistena_zavada,
        technik_jmeno: extracted.technik_jmeno,
        technik_cislo_opravneni: extracted.technik_cislo_opravneni,
        stranka,
      });
      stranka += 1;
    }

    return { zpravy, preskoceno };
  } finally {
    await loadingTask.destroy();
  }
}
