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
import { DruhRevize } from "./druhRevize";
import { OcrEngine, ocrRadkyStranky, vytvorOcr } from "./ocrStranky";

/**
 * Klasifikace "celkove_hodnoceni" do tří stavů – appka nikdy nemá jistě
 * vědět, že je zpráva v pořádku, pokud text přesně neodpovídá očekávané
 * formulaci. "KE_KONTROLE" proto pokrývá jak nerozpoznanou/neznámou
 * formulaci (např. "Vyhovuje s omezením" dle ČSN 33 1600 ed.2), tak úplně
 * chybějící pole – ať se to nikdy tiše nezamíchá mezi OK, ani mezi NOK.
 */
export type VysledekRevize = "OK" | "NOK" | "KE_KONTROLE";

/** Termín příští revize JINÉHO druhu, který protokol uvádí navíc (viz extractDalsiTerminyTlakovaNadoba). */
export type DalsiTermin = { druh: DruhRevize; termin: Date };

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
  /**
   * Druh revize (provozní/vnitřní/tlaková zkouška), pokud ho zpráva uvádí –
   * zatím jen u tlakových nádob (viz šablona E). Podle něj appka zprávu
   * spáruje s řádkem plánu odpovídající frekvence (viz lib/druhRevize.ts).
   * U ostatních šablon chybí/null.
   */
  druh_revize?: DruhRevize | null;
  /**
   * Další naplánované revize jiných druhů uvedené v téže zprávě (např.
   * "následující zkouška těsnosti: 11/2030" v provozní revizi) – appka je
   * dosadí jako termín odpovídajícího řádku plánu (viz
   * lib/revizniZpravyHistorie.ts), pokud ten nemá vlastní revizní zprávu.
   */
  dalsi_terminy?: DalsiTermin[];
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
// znovu (ze stejné "legacy" varianty, viz import pdfjsLib výš) – a stejně tak
// složku public/pdfjs-wasm (node_modules/pdfjs-dist/wasm), viz wasmUrl níž.
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
//
// KRITICKÉ: PDF generátor téhle šablony (ověřeno na DATAPLC01-2026.pdf)
// rozděluje i JEDNO ČÍSLO/KÓD do víc samostatných textových položek (typicky
// kvůli kerningu) – a appka je při skládání řádků (reconstructLines) mezi
// KAŽDOU položkou spojuje dvěma mezerami (viz join("  ") tamtéž), takže se
// i uprostřed čísla/kódu objeví mezera: "DATAPLC01-2026" se přečte jako
// "DATAPLC0 1- 202 6", "5.2.2026" jako "5 .2. 202 6" (ověřeno v appce na
// reálném souboru – appka zprávu jinak úplně přeskočila jako nerozpoznanou).
// Prostá/slovní pole (jméno technika, "bez zjevných závad") touhle
// korupcí NEtrpí. Extrakce popisků proto MUSÍ mezi každým znakem popisku
// tolerovat libovolný počet navíc vložených mezer (viz fuzzy()/
// findFuzzyValueAfterLabel() níž) a hodnoty číselných/kódových polí se před
// parsováním zbavují VŠECH mezer (bezpečné – taková pole mezery nikdy
// legitimně neobsahují), ne jen mezer na hranicích popisku.
// ---------------------------------------------------------------------------

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sestaví zdroj regexu, který v (potenciálně poškozeném) textu najde `label`
 * i s libovolně vloženými/chybějícími mezerami MEZI JEDNOTLIVÝMI ZNAKY (viz
 * komentář u šablony C výš) – appka nejdřív z `label` odstraní VŠECHNY
 * mezery (na jejich přesném původním počtu/umístění stejně nejde stavět,
 * viz tamní komentář – appka je vůbec nepoužívá) a mezi KAŽDOU dvojici
 * zbylých znaků povolí libovolný počet mezer (`\s*`, tedy i nula – pro
 * případ, že by PDF naopak nějakou legitimní mezeru úplně smazalo, ne jen
 * přidalo navíc).
 */
function fuzzy(label: string): string {
  return label
    .replace(/\s+/g, "")
    .split("")
    .map((ch) => escapeRegExpChar(ch) + "\\s*")
    .join("");
}

/** Fuzzy varianta findValueAfterLabel (viz fuzzy() výš) – vrátí zbytek řádku ZA popiskem. */
function findFuzzyValueAfterLabel(lines: string[], label: string): string | null {
  const re = new RegExp(fuzzy(label) + "(.*)", "i");
  for (const line of lines) {
    const match = line.match(re);
    if (match) return match[1];
  }
  return null;
}

/**
 * "14, Výsledky měření | název rozv : AGV P06  typ: xx  v.č.: xx …" – appka
 * bere hodnotu ZA popiskem "název rozv:" AŽ PO popisek "typ:" ze sousedního
 * sloupce na stejném řádku (stejný princip jako u šablony D, viz komentář
 * tam). PŘEDNOSTNÍ zdroj čísla zařízení (viz extractCisloZarizeniZarizeni
 * níž) – na reálné zprávě appka zjistila, že "Revize ev. č." NENÍ vždycky
 * číslo zařízení.
 */
function extractNazevRozvadeceZarizeni(lines: string[]): string | null {
  const raw = findFuzzyValueAfterLabel(lines, "název rozv:");
  if (!raw) return null;
  const dalsiPopisekIdx = raw.search(/typ\s*:/i);
  const hodnota = (dalsiPopisekIdx === -1 ? raw : raw.slice(0, dalsiPopisekIdx)).trim();
  return hodnota ? hodnota.replace(/\s+/g, "") : null;
}

/**
 * Číslo zařízení appka přednostně bere z "název rozv:" v sekci "14,
 * Výsledky měření" (viz extractNazevRozvadeceZarizeni výš) – na reálné
 * zprávě appka zjistila, že "Revize ev. č." NENÍ spolehlivý zdroj: u
 * některých zpráv je to skutečně kód zařízení + rok ("Revize ev. č.
 * DATAPLC01-2026"), ale u jiných je to NEZÁVISLÉ sekvenční číslo REVIZE bez
 * vztahu ke konkrétnímu zařízení (např. "Revize ev. č. YFAI-R-16-2025" u
 * zařízení AGVP06 – appka by z něj po odseknutí roku vytáhla nesmyslné
 * "YFAI-R-16"). Zálohou zůstává PŮVODNÍ postup přes "Revize ev. č." (kód
 * PŘED koncovou pomlčkou a rokem, ten se mění revizi od revize) pro případ,
 * že by "název rozv:" na nějaké zprávě chyběl.
 */
function extractCisloZarizeniZarizeni(lines: string[]): string | null {
  const zNazvuRozvadece = extractNazevRozvadeceZarizeni(lines);
  if (zNazvuRozvadece) return zNazvuRozvadece;

  const raw = findFuzzyValueAfterLabel(lines, "Revize ev. č.");
  if (!raw) return null;
  const cislo = raw.replace(/\s+/g, "");
  return cislo ? cislo.replace(/-\d{4}$/, "") : null;
}

/**
 * Datum appka hledá ve zbytku řádku ZA popiskem (ten na týhle šabloně sdílí
 * řádek se sloupcem revizního technika, viz reálná zpráva – "Datum ukončení
 * revize: 5.2.2026  Jméno: David Kadlec…") – VŠECHNY mezery se odstraní
 * ještě PŘED voláním parseFlexibleDate (ne až jako záložní pokus), protože
 * poškozené mezery uprostřed roku ("202 6") by jinak numerickou skupinu
 * uřízly na míň číslic a datum by se naparsovalo TICHÝM OMYLEM (rok "202"
 * misto "2026"), ne že by se rozpoznání jen nepovedlo.
 */
function extractDatumProvedeniZarizeni(lines: string[]): Date | null {
  const raw =
    findFuzzyValueAfterLabel(lines, "Datum ukončení revize:") ??
    findFuzzyValueAfterLabel(lines, "Datum zahájení revize:");
  return raw ? parseFlexibleDate(raw.replace(/\s+/g, "")) : null;
}

/** Viz komentář u extractDatumProvedeniZarizeni výš – stejný důvod odstranění mezer před parsováním. */
function extractTerminZarizeni(lines: string[]): Date | null {
  const raw = findFuzzyValueAfterLabel(lines, "Doporučený termín další revize:");
  return raw ? parseTerminHodnota(raw.replace(/\s+/g, "")) : null;
}

/**
 * "Jméno:  David Kadlec, Rušinov 1, Rušinov" – jméno je jen první část před
 * první čárkou, zbytek je adresa technika. Na rozdíl od číselných polí výš
 * appka mezery v zachycené hodnotě NEODSTRAŇUJE – jméno je prostý text (ne
 * kód/datum), skutečná mezera mezi jménem a příjmením je tu legitimní a
 * ověřeno (viz komentář u šablony C výš), že slovní pole touhle PDF
 * korupcí netrpí. Stejný popisek "Jméno:" se na zprávě objevuje ještě
 * jednou dole u nevyplněného razítka "Revizní zprávu převzal:" (jen
 * tečkovaná čára bez čárky) – findFuzzyValueAfterLabel vrací PRVNÍ shodu v
 * pořadí řádků, tedy tu u revizního technika nahoře na stránce.
 */
function extractTechnikJmenoZarizeni(lines: string[]): string | null {
  const raw = findFuzzyValueAfterLabel(lines, "Jméno:");
  if (!raw) return null;
  const jmeno = raw.split(",")[0]?.trim();
  return jmeno || null;
}

/**
 * "Ev. číslo: 2578/24/R-EZ-E1A, E1B" – appka mezery odstraní stejně jako u
 * čísla zařízení výš (kódové pole, mezery v něm nejsou legitimní, jen
 * artefakt poškozeného fontu PDF – viz komentář u šablony C).
 */
function extractCisloOpravneniZarizeni(lines: string[]): string | null {
  const raw = findFuzzyValueAfterLabel(lines, "Ev. číslo:");
  return raw ? raw.replace(/\s+/g, "") : null;
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
 * ZA touhle opakovanou hlavičkou). BEZ "č\." v regexu – appka na reálné
 * zprávě jiného nadpisu téže šablony (ZPRÁVA O REVIZI ELEKTROINSTALACE)
 * zjistila, že se tenhle znak umí ztratit/poškodit ("c. revize:" místo "č.
 * revize:", na jiné stránce dokonce úplně bez něj) – appka se tak spoléhá
 * jen na to, co se u týhle hlavičky NIKDY neliší: "Revizní technik:" na
 * úplném začátku řádku a "revize:" někde za ním.
 */
function jeOpakovanaHlavickaZarizeni(line: string): boolean {
  const t = line.trim();
  return /^Revizní\s+technik:.*revize\s*:/i.test(t) || /^Stránka\s+\d+\s+z\s+\d+$/i.test(t);
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
// Šablona D: druhá varianta "Zpráva o revizi elektrického zařízení" – STEJNÝ
// nadpis jako šablona C, ale jiný generátor/formulář (jiné popisky, dvou-
// sloupcové řádky "popisek: hodnota    popisek: hodnota" vedle sebe). Appka
// ji rozliší podle popisku "Revidovaný objekt:", který šablona C nemá (viz
// detectSablona), a musí se kontrolovat PŘED obecnou shodou na nadpis.
//
// Dvousloupcové řádky appce komplikují čtení: reconstructLines spojuje VŠECHNY
// sousední textové kousky stejným "  " bez ohledu na to, jestli šlo o mezeru
// uvnitř slova (poškozený font, viz šablona C) nebo o mezeru MEZI sloupci –
// nejde je od sebe rozeznat jen podle počtu mezer. Extrakce hodnot za
// popiskem (findFuzzyValueAfterLabel apod.) tím není dotčená (vždy vezme
// všechno ZA popiskem do konce řádku, ať už tam je cokoli dalšího), ale
// appka kvůli tomu nemůže spolehlivě určit, kde končí hodnota JEDNOHO
// sloupce a začíná další – u čísla zařízení (viz extractCisloZarizeniObjekt
// níž) se to řeší jinak, hledáním podle pomlčky.
// ---------------------------------------------------------------------------

/**
 * Číslo zařízení tu (na rozdíl od šablony C) není samostatné kódové pole,
 * ale poslední slovo volného popisu u "Revidovaný objekt:" (na reálné
 * zprávě: "...nabíjecí pro automaticky naváděné vozidlo – AGVN01") – appka
 * proto vezme text za POSLEDNÍ pomlčkou (en dash) v okně pár řádků od
 * popisku "Revidovaný objekt:" až po další známý popisek "Zdroj el.
 * energie:" (ať se nechytí nesouvisející pomlčka jinde ve zprávě, např.
 * "v.č. - xx – vývody" na další stránce). Mezery zachycené uvnitř kódu
 * (stejná porucha fontu jako u šablony C, viz "AGV N01" v diagnostice) se
 * odstraní stejně jako u ostatních kódových polí.
 */
function extractCisloZarizeniObjekt(lines: string[]): string | null {
  const idx = lines.findIndex((l) => new RegExp(fuzzy("Revidovaný objekt:"), "i").test(l));
  if (idx === -1) return null;

  const dalsiPopisekIdx = lines.findIndex(
    (l, i) => i > idx && new RegExp(fuzzy("Zdroj el. energie:"), "i").test(l)
  );
  const okno = lines.slice(idx, dalsiPopisekIdx === -1 ? idx + 8 : dalsiPopisekIdx).join(" ");

  const posledniPomlckaIdx = okno.lastIndexOf("–");
  if (posledniPomlckaIdx === -1) return null;

  const cislo = okno
    .slice(posledniPomlckaIdx + 1)
    .replace(/\s+/g, "")
    .replace(/[.,;]+$/, "");
  return cislo || null;
}

/**
 * "Ukončena dne: 24.8.2026" / "Zahájena dne: 24.8.2026" – appka jako datum
 * provedení revize přednostně bere "Ukončena dne" (stejná přednost jako u
 * šablony C mezi "Datum ukončení/zahájení revize"), se zálohou na "Zahájena
 * dne", kdyby v konkrétní zprávě první pole chybělo.
 */
function extractDatumProvedeniObjekt(lines: string[]): Date | null {
  const raw =
    findFuzzyValueAfterLabel(lines, "Ukončena dne:") ??
    findFuzzyValueAfterLabel(lines, "Zahájena dne:");
  return raw ? parseFlexibleDate(raw.replace(/\s+/g, "")) : null;
}

/** "Doporučený termín další revize: 08/2027 dle vnitřního předpisu provozovatele." */
function extractTerminObjekt(lines: string[]): Date | null {
  const raw = findFuzzyValueAfterLabel(lines, "Doporučený termín další revize:");
  return raw ? parseTerminHodnota(raw.replace(/\s+/g, "")) : null;
}

/**
 * "Revizní technik: David Kadlec    revize: Yanfeng Czechia Automotive" –
 * jméno je text ZA popiskem "Revizní technik:" AŽ PO popisek "revize:" ze
 * sousedního sloupce na stejném řádku (viz komentář u šablony D výš), ne do
 * konce celého řádku.
 */
function extractTechnikJmenoObjekt(lines: string[]): string | null {
  const raw = findFuzzyValueAfterLabel(lines, "Revizní technik:");
  if (!raw) return null;
  const dalsiPopisekIdx = raw.search(/revize\s*:/i);
  const jmeno = (dalsiPopisekIdx === -1 ? raw : raw.slice(0, dalsiPopisekIdx)).trim();
  return jmeno || null;
}

/** "osv.č.: 2578/24/R-EZ-E1A,E1B" – evidenční číslo oprávnění technika. */
function extractCisloOpravneniObjekt(lines: string[]): string | null {
  const raw = findFuzzyValueAfterLabel(lines, "osv.č.:");
  return raw ? raw.replace(/\s+/g, "") : null;
}

/**
 * Výsledek revize se (stejně jako u šablony C) nedá poznat z "Závěr:" – to
 * je vždycky stejná pozitivní úvodní věta bez ohledu na skutečný nález.
 * Skutečný výsledek je v poli "Zjištěné závady:", které je tu (na rozdíl od
 * číslovaného bodu "13, ZÁVADY" u šablony C) jen prostý popisek s hodnotou
 * na řádku/řádcích pod ním, končící popiskem "Závěr:".
 */
function extractVysledekZavadObjekt(
  lines: string[]
): { vysledek_revize: VysledekRevize; zjistena_zavada: string | null } {
  const idx = lines.findIndex((l) => new RegExp(fuzzy("Zjištěné závady:"), "i").test(l));
  if (idx === -1) return { vysledek_revize: "KE_KONTROLE", zjistena_zavada: null };

  const zaverIdx = lines.findIndex((l, i) => i > idx && new RegExp(fuzzy("Závěr:"), "i").test(l));
  const obsahRadky = (zaverIdx === -1 ? lines.slice(idx + 1) : lines.slice(idx + 1, zaverIdx))
    .map((l) => l.trim())
    .filter(Boolean);
  const text = obsahRadky.join(" ").trim();

  if (/^bez\s+zjevn[ýy]ch\s+z[áa]vad/i.test(text)) {
    return { vysledek_revize: "OK", zjistena_zavada: null };
  }
  if (text.length > 0) {
    return { vysledek_revize: "NOK", zjistena_zavada: text };
  }
  return { vysledek_revize: "KE_KONTROLE", zjistena_zavada: null };
}

/** "Závěr:" – celý odstavec prózy, jen pro zobrazení (klasifikace viz extractVysledekZavadObjekt). */
function extractZaverObjekt(lines: string[]): string {
  const idx = lines.findIndex((l) => new RegExp(fuzzy("Závěr:"), "i").test(l));
  if (idx === -1) return "";
  return lines[idx + 1]?.trim() ?? "";
}

/**
 * "Tato zpráva o revizi má  3 strany" – kolik stránek PDF dohromady tvoří
 * tuhle jednu revizní zprávu (jiná formulace i chybějící dvojtečka oproti
 * šabloně C, viz extractPocetStranZarizeni – appka proto hledá jen podle
 * popisku "Tato zpráva o revizi má" a číslo bere jako první číslici za ním).
 */
function extractPocetStranObjekt(lines: string[]): number | null {
  const raw = findFuzzyValueAfterLabel(lines, "Tato zpráva o revizi má");
  if (!raw) return null;
  const match = raw.match(/\d+/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Druhá a další stránka téhle šablony opakuje v záhlaví jméno technika a
 * název revidovaného objektu ("Revizní technik: David Kadlec  revize:
 * Yanfeng Czechia Automotive") – appka při spojování stránek (viz
 * parseRevizniZpravyPdf) tenhle řádek odfiltruje, ať se nepřimíchá do
 * obsahu žádné extrahované sekce. Druhý řádek hlavičky (adresa technika +
 * popis objektu končící kódem zařízení) záměrně NEODFILTROVÁVÁ – neexistuje
 * pro něj spolehlivý rozpoznávací vzor a jeho případné zachycení navíc
 * appce nevadí (žádná extrakce z něj mimo cislo_zarizeni nečte).
 */
function jeOpakovanaHlavickaObjekt(line: string): boolean {
  return /^Revizní\s+technik:.*revize\s*:/i.test(line.trim());
}

function extractObjektZprava(lines: string[]) {
  const { vysledek_revize, zjistena_zavada } = extractVysledekZavadObjekt(lines);
  return {
    cislo_zarizeni: extractCisloZarizeniObjekt(lines),
    datum_provedeni: extractDatumProvedeniObjekt(lines),
    novy_termin: extractTerminObjekt(lines),
    celkove_hodnoceni: extractZaverObjekt(lines),
    vysledek_revize,
    zjistena_zavada,
    technik_jmeno: extractTechnikJmenoObjekt(lines),
    technik_cislo_opravneni: extractCisloOpravneniObjekt(lines),
  };
}

// ---------------------------------------------------------------------------

// Šablona E: "REVIZNÍ ZPRÁVA o revizi tlakové nádoby stabilní" (zákon
// č. 250/2021 Sb., NV č. 192/2022 Sb.) – jedna zpráva na víc stránek, bez
// uvedeného počtu stran (appka spojuje stránky až do další titulní stránky).
// Číslo zařízení ("označení TN 088") se normalizuje na "TN088", druh revize
// (provozní/vnitřní/tlaková zkouška) určuje, ke kterému řádku plánu zpráva
// patří (viz lib/druhRevize.ts). Textová vrstva těchto PDF bývá z OCR
// (poškozená písmena, mezery uvnitř jmen), proto jsou popisky vyhledávané
// fuzzy a hodnoty tolerantní.
// ---------------------------------------------------------------------------

// České znaky s diakritikou -> třída povolující i variantu bez ní (OCR háčky a
// čárky často ztrácí nebo zamění).
const DIAKRITIKA_TRIDY: Record<string, string> = {
  á: "aá", č: "cč", ď: "dď", é: "eéě", ě: "eéě", í: "ií", ň: "nň", ó: "oó",
  ř: "rř", š: "sš", ť: "tť", ú: "uúů", ů: "uúů", ý: "yý", ž: "zž",
};

/**
 * Jako fuzzy(), navíc každý znak s diakritikou povolí i bez ní (viz
 * DIAKRITIKA_TRIDY) a dvojtečku v popisku i jako ; . , (OCR ji občas přečte
 * jako středník – "Výsledek revize; …"). Interpunkce se ale vyžaduje, ať
 * popisek nesedí na nadpis bez ní ("Průběh a výsledek revize").
 */
function fuzzyD(label: string): string {
  return label
    .replace(/\s+/g, "")
    .split("")
    .map((ch) => {
      if (ch === ":") return "[:;.,]\\s*";
      const trida = DIAKRITIKA_TRIDY[ch.toLowerCase()];
      return (trida ? `[${trida}]` : escapeRegExpChar(ch)) + "\\s*";
    })
    .join("");
}

/** Hodnota za popiskem na stejném řádku, nebo (když je za popiskem prázdno) první neprázdný řádek pod ním. */
function hodnotaZaPopiskem(lines: string[], label: string): string | null {
  const re = new RegExp(fuzzyD(label) + "(.*)", "i");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(re);
    if (!match) continue;
    const zbytek = match[1].trim();
    if (zbytek) return zbytek;
    const dalsi = lines.slice(i + 1).find((l) => l.trim());
    return dalsi ? dalsi.trim() : null;
  }
  return null;
}

function spojRadky(lines: string[]): string {
  return lines.join(" ").replace(/\s+/g, " ");
}

/**
 * Číslice z OCR → kód zařízení "TNxxx". Písmeno O na místě nuly (typická chyba
 * OCR) se opraví na 0, vedoucí nuly navíc ("TNO053" → 0053) se zahodí a číslo
 * se doplní na tři místa (plán drží TN001…TN147).
 */
function normalizujKodTN(cifry: string): string | null {
  if (!/\d/.test(cifry)) return null;
  return "TN" + String(Number(cifry.replace(/[Oo]/g, "0"))).padStart(3, "0");
}

// Volitelné "S" za "TN" ("TNS147") – některé protokoly číslo takhle zapisují,
// v plánu je zařízení vedené vždy jako TN147, proto se "S" zahodí.
const KOD_TN = /\bT\s?N\s?S?\s?[-–]?\s?([\dOo]{2,4})\b/g;

/**
 * Kódy zařízení, ke kterým protokol patří. Obvykle jedno ("označení TN 088"
 * → TN088), ale SESTAVA nádob má jeden protokol pro víc zařízení najednou
 * ("Umístění nádoby: sestava … evidenční číslo TNO053, TN 054, TN 055 …") –
 * pak appka vrátí všechny uvedené kódy a vznikne z toho zpráva pro každé.
 */
function extractCislaZarizeniTlakovaNadoba(lines: string[]): string[] {
  const text = lines.join(" ");

  const umisteni = text.match(
    new RegExp(fuzzyD("Umístění nádoby") + ":?(.{0,400}?)" + fuzzyD("Základní údaje"), "i")
  );
  if (umisteni && /sestav|evidenčn[ií]\s*[čc][ií]slo/i.test(umisteni[1])) {
    const kody = new Set<string>();
    for (const match of umisteni[1].matchAll(KOD_TN)) {
      const kod = normalizujKodTN(match[1]);
      if (kod) kody.add(kod);
    }
    if (kody.size >= 2) return Array.from(kody);
  }

  const vzory = [
    new RegExp(fuzzyD("označení") + ":?\\s*T\\s*N\\s*S?\\s*[-–]?\\s*([\\dOo]{1,4})", "i"),
    new RegExp(KOD_TN.source),
  ];
  for (const vzor of vzory) {
    const match = text.match(vzor);
    const kod = match ? normalizujKodTN(match[1]) : null;
    if (kod) return [kod];
  }
  return [];
}

function extractDatumProvedeniTlakovaNadoba(lines: string[]): Date | null {
  const raw = hodnotaZaPopiskem(lines, "Datum revize:");
  return raw ? parseFlexibleDate(raw.replace(/\s+/g, "")) : null;
}

/**
 * "Platnost provozní revize je do 3/2027." – termín příští revize. Měsíc/rok
 * (nebo plné datum) se hledá ve větě začínající "Platnost", jejíž konec
 * ("je do …") je u všech druhů revize stejný; mezery uvnitř čísla se
 * odstraní stejně jako u ostatních šablon (viz šablona C).
 */
function extractTerminTlakovaNadoba(lines: string[]): Date | null {
  const match = spojRadky(lines).match(
    /Platnost[^.]{0,60}?je\s*do\s*:?\s*(\d{1,2}\s*\/\s*\d{2,4}|\d{1,2}\s*\.\s*\d{1,2}\s*\.\s*\d{4})/i
  );
  return match ? parseTerminHodnota(match[1].replace(/\s+/g, "")) : null;
}

// Fráze "následující …: MM/RRRR" a řádek plánu (frekvence), na který patří.
// "Zkouška těsnosti" je u tlakových nádob (akumulátory) pětiletá kontrola,
// stejně jako vnitřní revize.
const NASLEDUJICI_TERMINY: { popisek: string; druh: DruhRevize }[] = [
  { popisek: "vnitřní revize", druh: "vnitrni" },
  { popisek: "zkouška těsnosti", druh: "vnitrni" },
  { popisek: "tlaková zkouška", druh: "zkouska" },
  { popisek: "provozní revize", druh: "provozni" },
];

/**
 * "Platnost revizní zprávy je do 4/2027     následující zkouška těsnosti:
 * 11/2030" – termín příští revize JINÉHO druhu, než jaký zpráva sama řeší.
 * Měsíc/rok se bere jako poslední den měsíce (stejně jako u hlavního termínu).
 */
function extractDalsiTerminyTlakovaNadoba(
  lines: string[],
  druhZpravy: DruhRevize | null
): DalsiTermin[] {
  const text = spojRadky(lines);
  const vysledek: DalsiTermin[] = [];
  for (const { popisek, druh } of NASLEDUJICI_TERMINY) {
    if (druh === druhZpravy || vysledek.some((v) => v.druh === druh)) continue;
    const match = text.match(
      new RegExp(
        fuzzyD("následující " + popisek) +
          ":?\\s*(\\d{1,2}\\s*/\\s*\\d{2,4}|\\d{1,2}\\s*\\.\\s*\\d{1,2}\\s*\\.\\s*\\d{4}|\\d{4})",
        "i"
      )
    );
    if (!match) continue;
    const hodnota = match[1].replace(/\s+/g, "");
    if (/^\d{4}$/.test(hodnota)) {
      // Jen rok ("následující zkouška těsnosti: 2030") – vždy konec toho roku (31. 12.).
      vysledek.push({ druh, termin: new Date(Date.UTC(Number(hodnota), 11, 31)) });
      continue;
    }
    const termin = parseTerminHodnota(hodnota);
    if (termin) vysledek.push({ druh, termin });
  }
  return vysledek;
}

function extractDruhRevizeTlakovaNadoba(lines: string[]): DruhRevize | null {
  const raw = hodnotaZaPopiskem(lines, "Druh revize:");
  if (!raw) return null;
  const text = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  // "provozní a zkouška těsnosti" (kombinovaný protokol) se bere jako provozní –
  // následující zkouška těsnosti se pak dosadí z "dalších termínů".
  if (/provoz/.test(text)) return "provozni";
  if (/vnitr/.test(text)) return "vnitrni";
  // Zkouška těsnosti je pětiletá kontrola, stejně jako vnitřní revize.
  if (/tesnost/.test(text)) return "vnitrni";
  if (/zkou|tlak/.test(text)) return "zkouska";
  return null;
}

/**
 * Výsledek se (na rozdíl od šablony C) čte z věty za "Výsledek revize:" a z
 * pole "Termín odstranění závad:" – "---" znamená žádné závady. NOK je
 * každá zpráva s vyplněným termínem odstranění závad nebo s větou "není
 * schopen provozu"; OK jen zpráva s větou "schopen dalšího bezpečného
 * provozu" a bez závad; cokoli jiného (i nerozpoznané) je KE_KONTROLE.
 */
function extractVysledekTlakovaNadoba(lines: string[]): {
  vysledek_revize: VysledekRevize;
  zjistena_zavada: string | null;
  celkove_hodnoceni: string;
} {
  const text = spojRadky(lines);
  const upozorneni = fuzzyD("UPOZORNĚNÍ");
  const vysledekMatch = text.match(
    new RegExp(
      fuzzyD("Výsledek revize:") + "(.*?)(?:" + fuzzyD("Termín odstranění závad") + "|" + upozorneni + "|$)",
      "i"
    )
  );
  const vysledekText = vysledekMatch ? vysledekMatch[1].trim() : "";
  // Pole "Termín odstranění závad" končí nadpisem UPOZORNĚNÍ – ten ale OCR
  // někdy vůbec nepřečte a pole by pak sahalo do následujícího obecného
  // odstavce ("Provoz tlakové nádoby se řídí…") a ten by se bral jako závada
  // (falešné NOK). Proto končí i na začátku tohoto odstavce.
  const konecZavad = [
    upozorneni,
    fuzzyD("Provoz tlakové nádoby"),
    fuzzyD("Provozní revizi je nutno"),
    fuzzyD("Provozovatel nádoby"),
  ].join("|");
  const zavadyMatch = text.match(
    new RegExp(fuzzyD("Termín odstranění závad") + "\\s*:?\\s*(.*?)(?:" + konecZavad + "|$)", "i")
  );
  // Skutečný záznam v poli je krátký (termín nebo pár slov) – delší text za
  // ním je už něco jiného, proto se bere jen začátek.
  const zavadyText = zavadyMatch ? zavadyMatch[1].trim().slice(0, 80) : "";
  // Pole "Termín odstranění závad" je prázdné ("---"), i když OCR přidá
  // zbloudilé znaky ("--- :", "— |"). Závada se bere jako uvedená, jen když
  // pole obsahuje číslici (termín) nebo slovo z aspoň 4 písmen, které
  // nepatří mezi běžné "nic tu není" fráze.
  const BEZ_ZAVAD = new Set(["žádné", "žádný", "žádná", "nejsou", "není", "nebyly", "bez", "závad", "závady", "neuvedeno", "nehodí"]);
  const zavadyPritomne = zavadyText
    .toLowerCase()
    .split(/[^\p{L}\d]+/u)
    .filter(Boolean)
    .some((token) => /\d/.test(token) || (token.length >= 4 && !BEZ_ZAVAD.has(token)));
  const zavadyPrazdne = !zavadyPritomne;

  // Verdikt (kladný/záporný) se hledá jen ve větě před "Platnost …" – za ní
  // následují poznámky a obecné texty, ve kterých se mohou objevit slova jako
  // "nesmí" a nesouvisí s výsledkem revize.
  const verdikt = vysledekText.split(/Platnost/i)[0];
  // "schop\S{0,3}" – zařízení s víc nádobami mají množné číslo ("tlakové nádoby
  // jsou schopny dalšího bezpečného provozu").
  const jePozitivni = new RegExp("schop\\S{0,3}\\s*" + fuzzyD("dalšího bezpečného provozu"), "i").test(
    verdikt
  );
  const jeNegativni = /nen[ií]\s*schopen|nejsou\s*schopn|nesm[ií]|nevyhovuj|zak[aá]z[aá]n/i.test(verdikt);

  let vysledek_revize: VysledekRevize = "KE_KONTROLE";
  let zjistena_zavada: string | null = null;
  if (!zavadyPrazdne || jeNegativni) {
    vysledek_revize = "NOK";
    zjistena_zavada =
      [vysledekText.slice(0, 500), zavadyPrazdne ? "" : `Termín odstranění závad: ${zavadyText}`]
        .filter(Boolean)
        .join(" ") || null;
  } else if (jePozitivni) {
    vysledek_revize = "OK";
  }
  return { vysledek_revize, zjistena_zavada, celkove_hodnoceni: vysledekText.slice(0, 300) };
}

/**
 * Vyčistí jméno technika přečtené z textu (OCR razítka kolem podpisu dělají
 * šum): zahodí vše před poslední interpunkcí ")" ":" ";" a slova psaná samými
 * velkými písmeny (nápisy razítka), a krátké zlomky po sobě (OCR rozdělené
 * "Š mí dl" / "Š m í d l") slije zpět do slova.
 */
function slijRozdelenaPismena(jmeno: string): string {
  // Svislé čáry razítka OCR čte jako "|" – jméno je až za poslední z nich.
  const bezSumu = jmeno
    .replace(/^.*[):;|]\s*/, "")
    // Slepené slovo s velkým písmenem uvnitř ("BohumilŠ") se rozdělí.
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
  const tokeny = bezSumu
    .split(/\s+/)
    .filter(Boolean)
    // OCR čte "l" jako "1" – u krátkých zlomků ("d1") se číslice vrátí na "l".
    .map((t) => (t.length <= 2 ? t.replace(/1/g, "l") : t))
    .filter((t) => !(t.length >= 3 && /^\p{Lu}+$/u.test(t)));
  const vystup: string[] = [];
  let beh: string[] = [];
  const uzavriBeh = () => {
    const slito = beh.join("");
    if (beh.length >= 3 || (beh.length >= 2 && slito.length >= 5)) vystup.push(slito);
    else vystup.push(...beh);
    beh = [];
  };
  for (const token of tokeny) {
    if (/^\p{L}{1,2}$/u.test(token)) {
      beh.push(token);
    } else {
      uzavriBeh();
      vystup.push(token);
    }
  }
  uzavriBeh();
  return vystup.join(" ");
}

type Technik = { technik_jmeno: string | null; technik_cislo_opravneni: string | null };

/**
 * Revizní technici, kteří protokoly tlakových nádob opakovaně podepisují.
 * Jméno a číslo oprávnění jsou v protokolu jen v razítku, které OCR čte
 * pokaždé jinak ("Šmíd", "Š midl", "Bohumil$ midl", někdy nic) – appka proto
 * technika pozná podle rozpoznatelného prefixu čísla oprávnění (tolerantně k
 * OCR záměnám 6/G, 0/O) NEBO podle podobnosti přečteného jména a uloží jeho
 * správné jméno a číslo. Nový technik se přidá sem; neznámý technik se uloží
 * tak, jak ho OCR přečetlo.
 */
const ZNAMI_TECHNICI: { vzorOpravneni: RegExp; jmeno: string; cisloOpravneni: string }[] = [
  {
    vzorOpravneni: /3\s*[6G]\s*7\s*[0O]\s*\/\s*2\s*4/i,
    jmeno: "Bohumil Šmídl",
    cisloOpravneni: "3670/24/R-TZ-NI,NII",
  },
];

function zakladJmena(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function levenshtein(a: string, b: string): number {
  const radek = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let predchozi = radek[0];
    radek[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const zaloha = radek[j];
      radek[j] = Math.min(radek[j] + 1, radek[j - 1] + 1, predchozi + (a[i - 1] === b[j - 1] ? 0 : 1));
      predchozi = zaloha;
    }
  }
  return radek[b.length];
}

function sjednotZnamehoTechnika(nalezeno: Technik, text: string): Technik {
  for (const znamy of ZNAMI_TECHNICI) {
    const podleOpravneni = znamy.vzorOpravneni.test(text);
    const podleJmena =
      nalezeno.technik_jmeno !== null &&
      levenshtein(zakladJmena(nalezeno.technik_jmeno), zakladJmena(znamy.jmeno)) <= 3;
    if (podleOpravneni || podleJmena) {
      return { technik_jmeno: znamy.jmeno, technik_cislo_opravneni: znamy.cisloOpravneni };
    }
  }
  return nalezeno;
}

/** "…provedl revizní technik tlakových nádob s Bohumil Š m í d l, evidenční číslo 3670/24/R-TZ-NI,NII" */
function extractTechnikTlakovaNadoba(lines: string[]): Technik {
  const text = spojRadky(lines);
  return sjednotZnamehoTechnika(precistTechnikaZTextu(text), text);
}

function precistTechnikaZTextu(text: string): Technik {
  const cisloVzor = "evidenčn[ií]\\s*[čc][ií]slo\\s*:?\\s*([\\w/\\-]+(?:\\s*,\\s*[\\w/\\-]+)*)";
  const plny = text.match(
    new RegExp(
      "proved\\S*\\s+revizn[ií]\\s+technik\\b[^,]{0,80}?\\bn[áa]dob\\s+(?:stabiln\\S*\\s+)?(?:s\\s+)?([^,]{2,60}?)\\s*,\\s*" +
        cisloVzor,
      "i"
    )
  );
  if (plny) {
    return {
      technik_jmeno: slijRozdelenaPismena(plny[1].trim()) || null,
      technik_cislo_opravneni: plny[2].replace(/\s+/g, "") || null,
    };
  }
  const jenCislo = text.match(new RegExp(cisloVzor, "i"));
  return {
    technik_jmeno: null,
    technik_cislo_opravneni: jenCislo ? jenCislo[1].replace(/\s+/g, "") : null,
  };
}

function extractTlakovaNadobaZprava(lines: string[]) {
  const { vysledek_revize, zjistena_zavada, celkove_hodnoceni } = extractVysledekTlakovaNadoba(lines);
  const druh_revize = extractDruhRevizeTlakovaNadoba(lines);
  return {
    dalsi_terminy: extractDalsiTerminyTlakovaNadoba(lines, druh_revize),
    cisla_zarizeni: extractCislaZarizeniTlakovaNadoba(lines),
    datum_provedeni: extractDatumProvedeniTlakovaNadoba(lines),
    novy_termin: extractTerminTlakovaNadoba(lines),
    celkove_hodnoceni,
    vysledek_revize,
    zjistena_zavada,
    druh_revize,
    ...extractTechnikTlakovaNadoba(lines),
  };
}

/** Titulní stránka zprávy o revizi tlakové nádoby (další stránky téže zprávy titulek nemají). */
function jeTitulniStrankaTlakoveNadoby(text: string): boolean {
  if (!new RegExp(fuzzyD("revizní zpráva"), "i").test(text)) return false;
  // Podtitulek "o revizi tlakové nádoby stabilní…" OCR u části protokolů
  // vůbec nepřečte – titulní stránku pozná appka i podle dvojice popisků
  // "Druh revize:" + "Umístění nádoby", které mají jen tyhle protokoly.
  return (
    new RegExp(fuzzyD("revizi tlakové nádoby"), "i").test(text) ||
    (new RegExp(fuzzyD("Druh revize:"), "i").test(text) &&
      new RegExp(fuzzyD("Umístění nádoby"), "i").test(text))
  );
}

// ---------------------------------------------------------------------------

type Sablona =
  | "spotrebic"
  | "pracovni_stroj"
  | "elektricke_zarizeni"
  | "elektricke_zarizeni_objekt"
  | "tlakova_nadoba";

/**
 * Podle nadpisu (a u posledních dvou šablon dalšího rozlišovacího popisku)
 * pozná, kterou ze čtyř známých šablon použít. Šablony C a D mají úplně
 * STEJNÝ nadpis "ZPRÁVA O REVIZI ELEKTRICKÉHO ZAŘÍZENÍ" (jiný generátor
 * zprávy, ne jiný typ revize) – appka je rozliší podle popisku "Revidovaný
 * objekt:", který má jen šablona D, a tenhle test proto MUSÍ proběhnout
 * PŘED obecnou shodou na nadpis, jinak by šablona D vždycky spadla pod C.
 */
function detectSablona(lines: string[]): Sablona | null {
  const text = lines.join("\n");
  if (/revizi elektrického zařízení pracovního stroje/.test(text)) return "pracovni_stroj";
  if (/revizi elektrického spotřebiče/.test(text)) return "spotrebic";
  if (jeTitulniStrankaTlakoveNadoby(text)) return "tlakova_nadoba";
  if (new RegExp(fuzzy("Revidovaný objekt:"), "i").test(text)) {
    return "elektricke_zarizeni_objekt";
  }
  // Case-insensitive, fuzzy (viz fuzzy() výš) a samostatně (na rozdíl od
  // šablon výš) – nadpis "ZPRÁVA O REVIZI ELEKTRICKÉHO ZAŘÍZENÍ" je na
  // reálné zprávě celý velkými písmeny a appka u týhle šablony obecně nesmí
  // spoléhat na přesné mezery (viz komentář u šablony C). Kontrola
  // "pracovního stroje" výš proběhne vždycky první (viz pořadí if větví),
  // takže se šablony nemůžou splést i přes společný podřetězec "elektrického
  // zařízení". BEZ koncového \b – v JS regexu bez "u" příznaku "\b" bere
  // "\w" jako ASCII-only ([A-Za-z0-9_]), takže hned za českým písmenem s
  // diakritikou (zařízen-Í) hranici slova vůbec nepozná a celý match by
  // tiše selhal.
  // "ZPRÁVA O REVIZI ELEKTROINSTALACE" – další reálně ověřený nadpis STEJNÉ
  // šablony C (číslované sekce "1, Předmět revize:" … "13, ZÁVADY:", "Revize
  // ev. č.", "Tato zpráva má: N stran" – appka na ní jen navíc zjistila, že
  // "Revize ev. č." nemusí být číslo zařízení, viz extractCisloZarizeniZarizeni).
  if (
    new RegExp(fuzzy("zpráva o revizi elektrického zařízení"), "i").test(text) ||
    new RegExp(fuzzy("zpráva o revizi elektroinstalace"), "i").test(text)
  ) {
    return "elektricke_zarizeni";
  }
  return null;
}

/**
 * Naparsuje jednu nebo víc revizních zpráv z PDF. Šablony A a B (spotřebič,
 * pracovní stroj) mají vždycky jednu zprávu na JEDNU stránku – appka je tak
 * prochází stránku po stránce (jeden nahraný soubor může obsahovat revizní
 * zprávy pro víc zařízení, jednu na stránku). Šablona C (obecné elektrické
 * zařízení) i šablona D (jiný generátor téhož typu zprávy, viz komentář u
 * ní výš) naopak zabírají VÍC stránek na jednu zprávu – appka po jejich
 * rozpoznání spojí řádky odpovídajícího počtu následujících stránek (dle
 * počtu stran uvedeného na první z nich) a pokračuje AŽ ZA nimi, ať appka
 * zbylé stránky téže zprávy znovu nezkoušela rozpoznat jako samostatné (a
 * nesprávně přeskočené) zprávy. Číslo zařízení a všechny ostatní údaje se
 * čtou výhradně z textového obsahu PDF, nikdy z názvu souboru. Podporuje
 * čtyři reálně ověřené šablony revizních zpráv (viz detectSablona výše) a
 * stránky neodpovídající žádné z nich přeskočí se srozumitelným důvodem.
 */
export async function parseRevizniZpravyPdf(
  data: ArrayBuffer,
  moznosti: { ocr?: boolean } = {}
): Promise<ParseRevizniZpravyResult> {
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
  const loadingTask = pdfjsLib.getDocument({
    data: data.slice(0),
    // Bez wasmUrl pdf.js v6 nenačte WASM dekodéry (JBIG2/CCITT masky z kopírek,
    // JPEG2000, ICC profily) a obrázky, které je potřebují, tiše ZAHODÍ
    // ("JBig2 failed to initialize") – u skenů v režimu vysoké komprese tak
    // zmizí celý text a OCR čte prázdný podklad. Soubory jsou v
    // public/pdfjs-wasm (kopie z node_modules/pdfjs-dist/wasm, viz poznámka u
    // ensureWorker). V Node skriptu se wasmUrl nepoužívá.
    ...(typeof window !== "undefined" ? { wasmUrl: `${window.location.origin}/pdfjs-wasm/` } : {}),
  });
  const ocrEngineRef: { current: OcrEngine | null } = { current: null };
  try {
    const doc = await loadingTask.promise;
    const zpravy: ParsedRevizniZprava[] = [];
    const preskoceno: SkippedPage[] = [];

    // OCR se spouští JEN u stránky, ze které pdf.js nepřečetl žádný text
    // (naskenovaný protokol), jen v prohlížeči a jen když to volající zapnul
    // (viz KolekceRevizi.ocr). Engine se vytvoří až při první takové stránce
    // a sdílí se pro celý soubor; uklízí se ve finally níž.
    const radkyStranky = async (cislo: number): Promise<string[]> => {
      const page = await doc.getPage(cislo);
      const content = await page.getTextContent();
      const radky = reconstructLines(content.items);
      if (radky.length > 0 || !moznosti.ocr || typeof window === "undefined") return radky;
      if (!ocrEngineRef.current) ocrEngineRef.current = await vytvorOcr();
      return ocrRadkyStranky(page, ocrEngineRef.current);
    };

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

      const lines = await radkyStranky(stranka);

      const sablona = detectSablona(lines);
      if (!sablona) {
        // Náhled skutečně přečteného textu (ne jen "nerozpoznáno") – u nové
        // varianty šablony (nebo PDF s poškozeným/nekompatibilním fontem,
        // kdy pdf.js přečte jiný text, než jaký je vidět při otevření
        // souboru) appka bez tohohle náhledu nedá poznat, PROČ detekce
        // selhala, a je potřeba hádat naslepo.
        const nahled = lines.join(" | ").replace(/[ \t]+/g, " ").trim();
        preskoceno.push({
          stranka,
          duvod: `nerozpoznaný typ revizní zprávy (obsah stránky: "${nahled}")`,
        });
        stranka += 1;
        continue;
      }

      if (sablona === "tlakova_nadoba") {
        // Zpráva nemá uvedený počet stran – appka přidá řádky všech dalších
        // stránek až po další titulní stránku (nebo konec souboru), viz
        // jeTitulniStrankaTlakoveNadoby.
        let pocetStran = 1;
        const vsechnyRadky = [...lines];
        while (stranka + pocetStran <= doc.numPages) {
          const dalsiRadky = await radkyStranky(stranka + pocetStran);
          if (jeTitulniStrankaTlakoveNadoby(dalsiRadky.join("\n"))) break;
          vsechnyRadky.push(...dalsiRadky);
          pocetStran += 1;
        }

        const extracted = extractTlakovaNadobaZprava(vsechnyRadky);
        // Náhled skutečně přečteného textu u každého selhání – textová vrstva
        // těchto PDF bývá z OCR a bez náhledu nejde poznat, co appka četla.
        const nahled = spojRadky(vsechnyRadky).slice(0, 700);
        const preskocit = (co: string) => {
          preskoceno.push({
            stranka,
            duvod: `nepodařilo se ${co} (šablona: tlaková nádoba; obsah stránky: "${nahled}")`,
          });
          stranka += pocetStran;
        };

        if (extracted.cisla_zarizeni.length === 0) {
          preskocit("najít číslo zařízení (označení TN…)");
          continue;
        }
        if (!extracted.datum_provedeni) {
          preskocit("najít datum revize");
          continue;
        }
        if (!extracted.novy_termin) {
          preskocit("rozpoznat termín příští revize (Platnost … je do …)");
          continue;
        }
        // Kontrola věrohodnosti – text z OCR může číslici přečíst chybně a
        // zpráva se hned zapisuje do plánu, proto appka nesmyslná data raději
        // přeskočí (s náhledem přečteného textu), než aby je uložila.
        const rokProvedeni = extracted.datum_provedeni.getUTCFullYear();
        if (rokProvedeni < 2000 || rokProvedeni > new Date().getUTCFullYear() + 1) {
          preskocit(`věrohodně přečíst datum revize (přečteno rok ${rokProvedeni} – možná chyba OCR)`);
          continue;
        }
        const rozdilLet = extracted.novy_termin.getUTCFullYear() - rokProvedeni;
        if (extracted.novy_termin <= extracted.datum_provedeni || rozdilLet > 11) {
          preskocit("věrohodně přečíst termín příští revize (nesedí k datu revize – možná chyba OCR)");
          continue;
        }

        // Jen věrohodné další termíny (po datu revize, nejvýš 11 let) – OCR
        // může číslici přečíst chybně a termín se zapisuje do plánu.
        const datumProvedeni = extracted.datum_provedeni;
        const dalsiTerminy = extracted.dalsi_terminy.filter(
          (t) =>
            t.termin > datumProvedeni &&
            t.termin.getUTCFullYear() - datumProvedeni.getUTCFullYear() <= 11
        );
        // Sestava nádob = jeden protokol pro víc zařízení: každé dostane vlastní
        // zprávu se stejnými údaji (stejná stránka, různé číslo zařízení).
        for (const cislo of extracted.cisla_zarizeni) {
          zpravy.push({
            cislo_zarizeni: cislo,
            datum_provedeni: datumProvedeni,
            novy_termin: extracted.novy_termin,
            celkove_hodnoceni: extracted.celkove_hodnoceni,
            vysledek_revize: extracted.vysledek_revize,
            zjistena_zavada: extracted.zjistena_zavada,
            technik_jmeno: extracted.technik_jmeno,
            technik_cislo_opravneni: extracted.technik_cislo_opravneni,
            stranka,
            druh_revize: extracted.druh_revize,
            dalsi_terminy: dalsiTerminy,
          });
        }
        stranka += pocetStran;
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

      if (sablona === "elektricke_zarizeni_objekt") {
        // Víc stránek jedné zprávy, stejný princip jako u šablony C výš.
        const pocetStran = extractPocetStranObjekt(lines) ?? 1;
        const vsechnyRadky = [...lines];
        for (let i = 1; i < pocetStran && stranka + i <= doc.numPages; i++) {
          const dalsiPage = await doc.getPage(stranka + i);
          const dalsiContent = await dalsiPage.getTextContent();
          vsechnyRadky.push(
            ...reconstructLines(dalsiContent.items).filter((l) => !jeOpakovanaHlavickaObjekt(l))
          );
        }

        const extracted = extractObjektZprava(vsechnyRadky);

        if (!extracted.cislo_zarizeni) {
          preskoceno.push({
            stranka,
            duvod: "nepodařilo se najít číslo zařízení u Revidovaného objektu (šablona: elektrické zařízení D)",
          });
          stranka += pocetStran;
          continue;
        }
        if (!extracted.datum_provedeni) {
          preskoceno.push({
            stranka,
            duvod: "nepodařilo se najít datum provedení revize (šablona: elektrické zařízení D)",
          });
          stranka += pocetStran;
          continue;
        }
        if (!extracted.novy_termin) {
          preskoceno.push({
            stranka,
            duvod: "nepodařilo se rozpoznat termín příští revize (šablona: elektrické zařízení D)",
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
    if (ocrEngineRef.current) await ocrEngineRef.current.ukonci();
    await loadingTask.destroy();
  }
}
