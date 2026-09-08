import { Timestamp } from "firebase/firestore";
import { ParsedRevizniZprava } from "@/lib/pdfRevizniZprava";

/**
 * Pole ukládaná do kolekce "revizni_zpravy" pro jednu naparsovanou revizní
 * zprávu. Sdílené mezi prvním nahráním PDF a pozdějším "přepočítáním" už
 * uložených zpráv (RevizniZpravyReprocess) – když appka bude umět
 * extrahovat další pole, stačí ho přidat sem, ať se to projeví na obou
 * místech automaticky.
 */
export function revizniZpravaToFirestoreFields(zprava: ParsedRevizniZprava) {
  return {
    cislo_zarizeni: zprava.cislo_zarizeni,
    datum_provedeni: Timestamp.fromDate(zprava.datum_provedeni),
    novy_termin: Timestamp.fromDate(zprava.novy_termin),
    celkove_hodnoceni: zprava.celkove_hodnoceni,
    technik_jmeno: zprava.technik_jmeno,
    technik_cislo_opravneni: zprava.technik_cislo_opravneni,
  };
}

/**
 * Pole zpětně kopírovaná do spárovaného záznamu v "planovane_revize", ať
 * jsou vidět přímo jako sloupce v Přehledu zařízení bez dalšího dotazu.
 * Stejně jako výše – sdílené mezi nahráním a přepočítáním.
 */
export function revizniZpravaToPlanovaneRevizeFields(zprava: ParsedRevizniZprava) {
  return {
    termin: Timestamp.fromDate(zprava.novy_termin),
    datum_provedeni: Timestamp.fromDate(zprava.datum_provedeni),
    technik_jmeno: zprava.technik_jmeno,
    technik_cislo_opravneni: zprava.technik_cislo_opravneni,
  };
}
