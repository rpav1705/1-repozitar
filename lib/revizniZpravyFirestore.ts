import { Timestamp } from "firebase/firestore";
import { ParsedRevizniZprava } from "@/lib/pdfRevizniZprava";

/**
 * Pole ukládaná do kolekce "revizni_zpravy" pro jednu naparsovanou revizní
 * zprávu. Sdílené mezi prvním nahráním PDF a pozdějším "přepočítáním" už
 * uložených zpráv (RevizniZpravyReprocess) – když appka bude umět
 * extrahovat další pole, stačí ho přidat sem, ať se to projeví na obou
 * místech automaticky.
 *
 * Pole zpětně kopírovaná do spárovaného záznamu v "planovane_revize" (ať
 * jsou vidět přímo jako sloupce v Přehledu zařízení bez dalšího dotazu) se
 * skládají v lib/revizniZpravyHistorie.ts – tam se totiž zároveň řeší,
 * která revizní zpráva u daného zařízení je skutečně ta nejnovější.
 */
export function revizniZpravaToFirestoreFields(zprava: ParsedRevizniZprava) {
  return {
    cislo_zarizeni: zprava.cislo_zarizeni,
    datum_provedeni: Timestamp.fromDate(zprava.datum_provedeni),
    novy_termin: Timestamp.fromDate(zprava.novy_termin),
    celkove_hodnoceni: zprava.celkove_hodnoceni,
    vysledek_revize: zprava.vysledek_revize,
    zjistena_zavada: zprava.zjistena_zavada,
    technik_jmeno: zprava.technik_jmeno,
    technik_cislo_opravneni: zprava.technik_cislo_opravneni,
  };
}

/**
 * Nastaví se jen při úspěšném zápisu z tlačítka "Znovu zpracovat uložené
 * revizní zprávy" (ne při prvním nahrání) – appka podle něj v
 * RevizniZpravyReprocess pozná, jestli tuhle zprávu tohle tlačítko už někdy
 * viděla (výchozí dávka "nové" pak zpracuje jen ty, co ještě ne). Sdílené i
 * s lib/revizniZpravyHistorie.ts (dedup záznamů se stejným datem provedení
 * upřednostní ten s novějším "poslední úpravou") a se
 * scripts/reprocess-all-revizni-zpravy.ts (Node ekvivalent stejného
 * tlačítka), ať název pole nikde neujede.
 */
export const REPROCESS_MARKER_FIELD = "naposledy_zpracovano_reprocessem";

/**
 * Ořízne znak, který by v Firestore ID dokumentu způsobil problém (lomítko
 * dělá z ID vnořenou cestu) – "." a ".." appka jako ID nepoužije vůbec
 * (Firestore je odmítá). Sdílené mezi stabilním ID plánované revize (podle
 * "PÚ", viz handleSave v app/nahrat/page.tsx) a revizní zprávy (viz
 * revizniZpravaDocId níž).
 */
export function sanitizeDocId(raw: string): string {
  const cleaned = raw.replace(/\//g, "_").trim();
  return cleaned === "." || cleaned === ".." ? "" : cleaned;
}

/**
 * Stabilní ID dokumentu v "revizni_zpravy", odvozené z čísla zařízení a
 * data provedení revize – umožňuje appce zapisovat přes setDoc místo addDoc.
 * Opakované nahrání/zpracování STEJNÉ revize (stejné zařízení, stejné datum
 * provedení) tak vždy přepíše existující záznam, místo aby vedle něj
 * vytvořilo duplicitu s náhodným ID (přesně tohle appka dřív dělala u
 * addDoc – viz i dedup starších záznamů v lib/revizniZpravyHistorie.ts,
 * který existující duplicity z doby před touhle opravou uklidí).
 *
 * Datum se čte VÝHRADNĚ přes UTC komponenty (getUTCFullYear/getUTCMonth/
 * getUTCDate), NE přes lokální getFullYear/getMonth/getDate – datumProvedeni
 * sem přichází z parseFlexibleDate (lib/parseDate.ts), který ho od teď VŽDY
 * skládá přes Date.UTC(). Čtení lokálními gettery by u appky běžící ve dvou
 * různých časových zónách (prohlížeč Europe/Prague vs. Node skript v UTC)
 * mohlo z JEDNOHO A TOHOŽ Timestampu vyčíst DVA RŮZNÉ kalendářní dny podle
 * toho, kde kód zrovna běží – přesně tenhle nesoulad u zařízení 212261
 * způsobil, že appka spočítala pro STEJNÉ nominální datum dvě různá ID.
 */
export function revizniZpravaDocId(cisloZarizeni: string, datumProvedeni: Date): string {
  const cisloId = sanitizeDocId(cisloZarizeni);
  if (!cisloId) return "";
  const rok = datumProvedeni.getUTCFullYear();
  const mesic = String(datumProvedeni.getUTCMonth() + 1).padStart(2, "0");
  const den = String(datumProvedeni.getUTCDate()).padStart(2, "0");
  return `${cisloId}_${rok}-${mesic}-${den}`;
}
