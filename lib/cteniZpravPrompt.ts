/**
 * DOČASNÁ integrace AI čtení revizních zpráv – společný prompt a validace
 * odpovědi modelu (Gemini přes Firebase AI Logic v prohlížeči, Claude/Gemini
 * přes server route). Viz lib/claudeCteniZprav.ts.
 */

import type { ClaudeCteniVysledek } from "./claudeCteniZprav";

const PROMPT_ZAKLAD = `Jsi asistent, který čte české revizní zprávy (elektro revize, tlakové nádoby) z přiloženého PDF. Z dokumentu vyčti údaje o JEDNÉ revizní zprávě a odpověz VÝHRADNĚ jedním JSON objektem (bez dalšího textu, bez markdownu) s těmito klíči:

{
  "je_revizni_zprava": boolean,        // false, pokud dokument není revizní zpráva/protokol o revizi
  "cislo_zarizeni": string|null,       // kód zařízení přesně jak je uvedený, bez mezer (viz pravidla níž)
  "datum_provedeni": "YYYY-MM-DD"|null,// datum provedení / ukončení revize
  "novy_termin": "YYYY-MM-DD"|null,    // termín příští revize; je-li uveden jen měsíc/rok ("09/2027", "říjen 2026"), použij POSLEDNÍ den měsíce; jen rok = 31. 12.
  "celkove_hodnoceni": string|null,    // celkové hodnocení/posudek jednou větou, např. "Vyhovuje" nebo "Nevyhovuje"; u "schopné provozu" napiš "Vyhovuje"
  "zjistena_zavada": string|null,      // text zjištěných závad/poznámek, null když žádné
  "technik_jmeno": string|null,        // jméno revizního technika
  "technik_cislo_opravneni": string|null, // evidenční číslo oprávnění technika
  "druh_revize": "provozni"|"vnitrni"|"zkouska"|null, // jen u tlakových nádob (provozní revize / vnitřní revize / tlaková zkouška), jinak null
  "jistota": "vysoka"|"stredni"|"nizka", // jak moc jsi si jistý správností cislo_zarizeni a obou dat
  "poznamka": string                   // krátce česky: z čeho jsi číslo zařízení vzal, co bylo nejasné
}

Pravidla pro cislo_zarizeni:
- Protokol spotřebiče: pole "Inventární číslo" (ne "Spotřebič ID", ne výrobní číslo).
- Zpráva o revizi elektrického zařízení/instalace/rozvaděče: označení rozvaděče z pole "název rozv." (např. DT1, RSUBRACK1, AGVP06); když pole chybí nebo je prázdné, označení rozvaděče z "Předmět revize" ("rozvaděč RNAB společnosti…", u zpráv Revizero "RA1 - Rozvaděč elektrické instalace…"). NIKDY ne číslo revize "YFAI-R-…" ("Revize ev. č.") ani "REV-RRRR-NNN".
- Tlaková nádoba: kód TN… z hlavičky protokolu (např. TN0053, TNS147).
- Nic si nedomýšlej. Pokud údaj v dokumentu není, dej null a jistotu "nizka".`;

export function pridatTyp(typ: string): string {
  return typ === "tlakove_nadoby"
    ? `${PROMPT_ZAKLAD}\n\nDokument je z oblasti TLAKOVÝCH NÁDOB.`
    : `${PROMPT_ZAKLAD}\n\nDokument je z oblasti ELEKTRO revizí.`;
}

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

function platneDatum(v: unknown): string | null {
  if (typeof v !== "string" || !DATUM_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const rok = d.getUTCFullYear();
  return rok >= 2000 && rok <= 2100 ? v : null;
}

function textNeboNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function vyjmoutJson(text: string): unknown {
  const zacatek = text.indexOf("{");
  const konec = text.lastIndexOf("}");
  if (zacatek === -1 || konec <= zacatek) throw new Error("odpověď modelu neobsahuje JSON");
  return JSON.parse(text.slice(zacatek, konec + 1));
}

/** Zvaliduje JSON z modelu a vrátí výsledek čtení (vyhodí chybu, když odpověď není použitelný JSON). */
export function vyhodnotitOdpoved(text: string): ClaudeCteniVysledek {
  const data = vyjmoutJson(text) as Record<string, unknown>;

  if (data.je_revizni_zprava === false) {
    return { ok: false, duvod: `Claude: nejde o revizní zprávu (${textNeboNull(data.poznamka) ?? "bez vysvětlení"})` };
  }
  const cislo = textNeboNull(data.cislo_zarizeni)?.replace(/\s+/g, "") ?? null;
  const datum = platneDatum(data.datum_provedeni);
  const termin = platneDatum(data.novy_termin);
  const poznamka = textNeboNull(data.poznamka) ?? "";
  if (!cislo || !datum || !termin) {
    const chybi = [!cislo && "číslo zařízení", !datum && "datum provedení", !termin && "termín příští revize"]
      .filter(Boolean)
      .join(", ");
    return { ok: false, duvod: `Claude nenašel: ${chybi}${poznamka ? ` (${poznamka})` : ""}` };
  }
  const jistota =
    data.jistota === "vysoka" || data.jistota === "stredni" || data.jistota === "nizka" ? data.jistota : "nizka";
  const druh =
    data.druh_revize === "provozni" || data.druh_revize === "vnitrni" || data.druh_revize === "zkouska"
      ? data.druh_revize
      : null;

  return {
    ok: true,
    cislo_zarizeni: cislo,
    datum_provedeni: datum,
    novy_termin: termin,
    celkove_hodnoceni: textNeboNull(data.celkove_hodnoceni) ?? "",
    zjistena_zavada: textNeboNull(data.zjistena_zavada),
    technik_jmeno: textNeboNull(data.technik_jmeno),
    technik_cislo_opravneni: textNeboNull(data.technik_cislo_opravneni),
    druh_revize: druh,
    jistota,
    poznamka,
  };
}
