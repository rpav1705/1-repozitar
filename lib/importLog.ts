import { addDoc, collection, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

/**
 * Kolektor historie importů/zpracování – jeden záznam PER běh (import plánu
 * .xls, nebo jedno spuštění zpracování revizních zpráv), ať dashboard umí
 * ukázat "poslední import" karty bez nutnosti to dopočítávat z aktuálního
 * stavu dat (ten totiž neříká NIC o tom, kdy a s jakým výsledkem proběhl
 * poslední běh – jen jaký je výsledný stav teď).
 */
export const IMPORT_LOG_COLLECTION = "import_log";

/**
 * Kolik čísel zařízení appka u jedné položky logu maximálně uloží do
 * Firestore dokumentu – u výjimečně velkých dávek (tisíce zařízení) by jinak
 * seznam mohl narazit na limit velikosti dokumentu (1 MiB). Souhrnný POČET se
 * ukládá vždy celý (pole "pocty"), takže se neztrácí, i když se seznam pro
 * rozklikávací detail ořízne.
 */
const LOG_ITEMS_LIMIT = 1000;

function orizni(items: string[]): string[] {
  return items.slice(0, LOG_ITEMS_LIMIT);
}

export type PlanImportLogInput = {
  /** Čísla zařízení nově přidaných záznamů (dřív v "planovane_revize" neexistovaly). */
  pridano: string[];
  /** Čísla zařízení existujících záznamů, které tenhle import přepsal. */
  aktualizovano: string[];
  /** Čísla zařízení smazaných jako INACTIVE. */
  smazano: string[];
};

/**
 * Zapíše záznam o proběhlém importu plánu (.xls) – volá se z handleSave v
 * PlanUpload (app/nahrat/page.tsx) PO úspěšném dokončení importu (včetně
 * úklidu neaktivních zařízení).
 */
export async function zapisPlanImportLog(input: PlanImportLogInput): Promise<void> {
  await addDoc(collection(db, IMPORT_LOG_COLLECTION), {
    typ: "plan",
    cas: Timestamp.fromDate(new Date()),
    pocty: {
      pridano: input.pridano.length,
      aktualizovano: input.aktualizovano.length,
      smazano: input.smazano.length,
    },
    polozky: {
      pridano: orizni(input.pridano),
      aktualizovano: orizni(input.aktualizovano),
      smazano: orizni(input.smazano),
    },
  });
}

/**
 * Kterou ze tří akcí zpracování revizních zpráv (viz app/nahrat/page.tsx)
 * tenhle běh spustil – dashboard to ukazuje spolu s výsledkem, ať je jasné,
 * jestli šlo o čerstvě nahrané PDF, nebo o (znovu)zpracování už uložených.
 */
export type RevizniZpravyImportZdroj =
  | "nahrani"
  | "zpracovat_ulozene_nove"
  | "zpracovat_ulozene_vse";

export type RevizniZpravyImportLogInput = {
  zdroj: RevizniZpravyImportZdroj;
  /** Úspěšně rozpoznané/přepočítané revizní zprávy v tomhle běhu. */
  zpracovano: number;
  /** Stránky/zprávy, které se v tomhle běhu nepodařilo rozpoznat/zpracovat. */
  chyba: number;
  /** Čísla zařízení dotčená tímhle během (pro rozklikávací detail). */
  zarizeni: string[];
};

/**
 * Zapíše záznam o proběhlém zpracování revizních zpráv – volá se ze všech
 * tří míst, která appka k tomu má: přímé nahrání PDF (RevizniZpravyUpload) a
 * obě tlačítka v RevizniZpravyReprocess ("jen nové" i "úplně vše").
 */
export async function zapisRevizniZpravyImportLog(
  input: RevizniZpravyImportLogInput
): Promise<void> {
  await addDoc(collection(db, IMPORT_LOG_COLLECTION), {
    typ: "revizni_zpravy",
    cas: Timestamp.fromDate(new Date()),
    zdroj: input.zdroj,
    pocty: {
      zpracovano: input.zpracovano,
      chyba: input.chyba,
    },
    polozky: {
      zarizeni: orizni(input.zarizeni),
    },
  });
}
