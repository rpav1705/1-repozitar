/**
 * Sdílená logika pro analýzu revizních zpráv, které se NEspárovaly
 * jednoznačně na přesně jeden záznam v "planovane_revize" (stejné párování
 * podle čísla zařízení jako appka dělá při nahrání PDF, viz handleProcess v
 * app/nahrat/page.tsx). Použitá z API route
 * (app/api/analyza-nesparovanych-zprav/route.ts), ať se výpočet neduplikuje
 * a appka v prohlížeči i server počítají úplně stejně.
 *
 * Vstupní typy jsou úmyslně odpojené od konkrétního Firestore SDK – klientský
 * "firebase/firestore" a serverový "firebase-admin/firestore" mají
 * nekompatibilní typy (Timestamp, DocumentData) – volající si z vlastního
 * query snapshotu vytáhne jen tahle holá pole.
 *
 * Počítá se VŽDY nad aktuálním stavem obou kolekcí, ne nad polem
 * "parovani_stav" uloženým na zprávě v okamžiku jejího zpracování – to je
 * jen snímek z tehdejšího stavu plánu a může zastarat (např. po úklidu
 * duplicitních PÚ v importu plánu se dřívější "víc shod" může mezitím stát
 * jednoznačnou shodou, aniž by appka zprávu znovu zpracovávala).
 */

import { jeDruhRevize, planOdpovidaDruhu } from "./druhRevize";

export type RevizniZpravaRadek = {
  cislo_zarizeni: string;
  soubor_nazev: string;
  stranka: number;
  /** Druh revize ze zprávy (tlakové nádoby) – viz lib/druhRevize.ts; bez něj chybí/null. */
  druh_revize?: string | null;
};

export type PlanovanaRevizeRadek = {
  cislo_zarizeni: string;
  pu: string;
  /** Frekvence řádku plánu (roky) – podle ní se zpráva s druhem revize páruje na řádek. */
  frekvence?: number | null;
};

export type DetailViceShod = {
  cislo_zarizeni: string;
  pocet_pu: number;
  seznam_pu: string[];
  soubor: string;
  stranka: number;
};

export type DetailBezShody = {
  cislo_zarizeni: string;
  soubor: string;
  stranka: number;
};

export type DetailChybiCislo = {
  soubor: string;
  stranka: number;
};

/** Kolik položek appka u jedné skupiny v odpovědi API maximálně vrátí – u
 *  velkých dávek (tisíce zpráv) by jinak JSON odpověď zbytečně narostla, i
 *  když se v appce stejně zobrazuje jen omezený náhled. Souhrnný POČET
 *  ("pocet" u každé skupiny) je vždy úplný, i když se seznam detailů ořízne. */
export const DETAIL_LIMIT = 500;

export type VysledekAnalyzyNesparovanych = {
  celkemZprav: number;
  celkemPlanu: number;
  celkemNesparovanych: number;
  viceShod: { pocet: number; detaily: DetailViceShod[] };
  bezShody: { pocet: number; detaily: DetailBezShody[] };
  chybiCisloZarizeni: { pocet: number; detaily: DetailChybiCislo[] };
};

/**
 * Rozdělí revizní zprávy, které se nespárovaly na přesně jeden záznam plánu,
 * do tří důvodů:
 *  - "viceShod": číslu zařízení odpovídá v plánu VÍC než jeden řádek/PÚ
 *    (víc typů revize, nebo pozůstatek duplicitního importu) – appka bez
 *    ruční kontroly neví, kterého typu revize se zpráva týká.
 *  - "bezShody": číslu zařízení neodpovídá v plánu ŽÁDNÝ řádek (zařízení v
 *    plánu vůbec není, nebo bylo mezitím smazáno).
 *  - "chybiCisloZarizeni": ze zprávy samotné se nepodařilo přečíst číslo
 *    zařízení (nemělo by nastat u úspěšně naparsované zprávy, appka to ale
 *    pro jistotu taky hlídá, ať se žádná zpráva neztratí beze zmínky).
 * Zprávy s přesně jednou shodou (jednoznačně spárované) se do výsledku
 * nezapočítávají vůbec – ty appka žádnou pozornost nevyžadují.
 */
export function analyzujNesparovaneZpravy(
  zpravy: RevizniZpravaRadek[],
  plany: PlanovanaRevizeRadek[]
): VysledekAnalyzyNesparovanych {
  const planyPodleZarizeni = new Map<string, PlanovanaRevizeRadek[]>();
  for (const p of plany) {
    if (!p.cislo_zarizeni) continue;
    const seznam = planyPodleZarizeni.get(p.cislo_zarizeni) ?? [];
    seznam.push(p);
    planyPodleZarizeni.set(p.cislo_zarizeni, seznam);
  }

  const viceShod: DetailViceShod[] = [];
  const bezShody: DetailBezShody[] = [];
  const chybiCislo: DetailChybiCislo[] = [];

  for (const z of zpravy) {
    if (!z.cislo_zarizeni) {
      chybiCislo.push({ soubor: z.soubor_nazev, stranka: z.stranka });
      continue;
    }
    // Zpráva s druhem revize se páruje jen na řádek plánu odpovídající
    // frekvence (stejně jako při nahrání PDF, viz handleProcess), ostatní
    // řádky téhož zařízení se nepočítají.
    const planyZarizeni = planyPodleZarizeni.get(z.cislo_zarizeni) ?? [];
    const druh = z.druh_revize;
    const odpovidajici = jeDruhRevize(druh)
      ? planyZarizeni.filter((p) => planOdpovidaDruhu(p.frekvence, druh))
      : planyZarizeni;
    const seznamPu = odpovidajici.map((p) => p.pu);
    if (seznamPu.length === 0) {
      bezShody.push({ cislo_zarizeni: z.cislo_zarizeni, soubor: z.soubor_nazev, stranka: z.stranka });
    } else if (seznamPu.length > 1) {
      viceShod.push({
        cislo_zarizeni: z.cislo_zarizeni,
        pocet_pu: seznamPu.length,
        seznam_pu: seznamPu,
        soubor: z.soubor_nazev,
        stranka: z.stranka,
      });
    }
  }

  return {
    celkemZprav: zpravy.length,
    celkemPlanu: plany.length,
    celkemNesparovanych: viceShod.length + bezShody.length + chybiCislo.length,
    viceShod: { pocet: viceShod.length, detaily: viceShod.slice(0, DETAIL_LIMIT) },
    bezShody: { pocet: bezShody.length, detaily: bezShody.slice(0, DETAIL_LIMIT) },
    chybiCisloZarizeni: { pocet: chybiCislo.length, detaily: chybiCislo.slice(0, DETAIL_LIMIT) },
  };
}
