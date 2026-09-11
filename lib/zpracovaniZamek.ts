"use client";

import { useEffect, useState } from "react";
import { doc, DocumentData, onSnapshot, runTransaction, setDoc, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

/**
 * Sdílený zámek "právě něco importuje/zpracovává" – JEDEN dokument společný
 * pro import plánu (.xls) i všechny tři akce zpracování revizních zpráv,
 * protože obě skupiny operací zapisují (i) do "planovane_revize" (import
 * plánu přes handleSave, zpracování revizních zpráv přes
 * synchronizujHistoriiZarizeni v lib/revizniZpravyHistorie.ts) – souběh mezi
 * NIMI NAVZÁJEM by mohl vést k tomu, že jeden běh přepíše rozpracovaný zápis
 * druhého (např. import plánu by mohl přepsat termín, který zrovna ve
 * stejné chvíli dosadilo zpracování čerstvě nahrané revizní zprávy). Appka
 * proto dovolí v jednu chvíli jen JEDNU z těchto čtyř operací, napříč všemi
 * otevřenými kartami/prohlížeči/uživateli.
 */
const LOCK_COLLECTION = "app_locks";
const LOCK_DOC_ID = "zpracovani";

function lockRef() {
  return doc(db, LOCK_COLLECTION, LOCK_DOC_ID);
}

/**
 * Bez aktualizace heartbeatu déle než tohle appka pokládá zámek za opuštěný
 * (typicky zavřená karta/pád prohlížeče uprostřed běhu, kdy se `finally`
 * s uvolniZamek() vůbec nestihne provést) a dovolí ho převzít jinému
 * zpracování – jinak by appka zůstala "zaseknutá" v domnění, že něco pořád
 * běží, i když ve skutečnosti už dávno nic neběží.
 */
const LOCK_STALE_MS = 2 * 60 * 1000;

/** Jak často běžící operace obnovuje heartbeat – musí být citelně kratší
 *  než LOCK_STALE_MS, ať doopravdy běžící (jen pomalejší) zpracování appka
 *  omylem nepovažuje za opuštěné. */
const HEARTBEAT_INTERVAL_MS = 20_000;

export type ZpracovaniTyp =
  | "plan"
  | "revizni_zpravy_nahrani"
  | "revizni_zpravy_nove"
  | "revizni_zpravy_vse";

export const ZPRACOVANI_TYP_LABELS: Record<ZpracovaniTyp, string> = {
  plan: "Import plánu (.xls)",
  revizni_zpravy_nahrani: "Nahrání revizních zpráv (PDF)",
  revizni_zpravy_nove: "Zpracování uložených revizních zpráv",
  revizni_zpravy_vse: "Přepočítání úplně všech revizních zpráv",
};

export type ZamekInfo = {
  /** Uložený příznak z Firestore – NEZAHRNUJE kontrolu staleness, na tu viz jeZamekAktivni(). */
  bezi: boolean;
  typ: ZpracovaniTyp | null;
  uzivatelEmail: string;
  zacatek: Date | null;
  heartbeat: Date | null;
};

const PRAZDNY_ZAMEK: ZamekInfo = {
  bezi: false,
  typ: null,
  uzivatelEmail: "",
  zacatek: null,
  heartbeat: null,
};

function jeTypZpracovani(value: unknown): value is ZpracovaniTyp {
  return (
    value === "plan" ||
    value === "revizni_zpravy_nahrani" ||
    value === "revizni_zpravy_nove" ||
    value === "revizni_zpravy_vse"
  );
}

function mapZamek(data: DocumentData | undefined): ZamekInfo {
  return {
    bezi: data?.bezi === true,
    typ: jeTypZpracovani(data?.typ) ? data.typ : null,
    uzivatelEmail: typeof data?.uzivatel_email === "string" ? data.uzivatel_email : "",
    zacatek: data?.zacatek instanceof Timestamp ? data.zacatek.toDate() : null,
    heartbeat: data?.heartbeat instanceof Timestamp ? data.heartbeat.toDate() : null,
  };
}

/** Jestli je zámek podle uloženého heartbeatu opravdu (nejspíš pořád) aktivní. */
export function jeZamekAktivni(info: ZamekInfo): boolean {
  if (!info.bezi) return false;
  if (!info.heartbeat) return false;
  return Date.now() - info.heartbeat.getTime() <= LOCK_STALE_MS;
}

/**
 * Pokusí se získat sdílený zámek. Vrátí { ok: true } (zámek OD TEĎ drží
 * volající kód, dokud ho nezavolá uvolniZamek()), nebo { ok: false, info }
 * s informací, kdo a od kdy ho drží. Běží jako Firestore transakce, ať dva
 * současné pokusy o zámek nemohly obě "vidět" volno a získat ho zároveň.
 */
export async function ziskejZamek(
  typ: ZpracovaniTyp,
  uzivatelEmail: string
): Promise<{ ok: true } | { ok: false; info: ZamekInfo }> {
  const ref = lockRef();
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const info = mapZamek(snap.exists() ? snap.data() : undefined);

    if (jeZamekAktivni(info)) {
      return { ok: false as const, info };
    }

    const now = Timestamp.fromDate(new Date());
    tx.set(ref, {
      bezi: true,
      typ,
      uzivatel_email: uzivatelEmail,
      zacatek: now,
      heartbeat: now,
    });
    return { ok: true as const };
  });
}

/**
 * Uvolní zámek – MUSÍ se volat vždy v `finally` kolem operace, co si zámek
 * vzala (ať appka nezůstane "zaseknutá" v domnění, že něco běží, i po chybě
 * nebo ručním přerušení uprostřed zpracování).
 */
export async function uvolniZamek(): Promise<void> {
  await setDoc(lockRef(), { bezi: false }, { merge: true });
}

/**
 * Průběžně obnovuje heartbeat běžícího zpracování. Spustit hned po úspěšném
 * ziskejZamek() a vrácené ID předat clearInterval() ve stejném `finally`,
 * kde se volá uvolniZamek().
 */
export function zahajHeartbeat(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    setDoc(lockRef(), { heartbeat: Timestamp.fromDate(new Date()) }, { merge: true }).catch(() => {
      // Přechodný výpadek sítě – další tik za HEARTBEAT_INTERVAL_MS to
      // zkusí znovu, nemá smysl to samostatně ošetřovat/hlásit.
    });
  }, HEARTBEAT_INTERVAL_MS);
}

/** Srozumitelná zpráva pro uživatele, kterému appka odmítla spustit
 *  operaci, protože zámek zrovna drží někdo jiný. */
export function popisZamekOdmitnuti(info: ZamekInfo): string {
  const typLabel = info.typ ? ZPRACOVANI_TYP_LABELS[info.typ] : "jiné zpracování";
  const kdo = info.uzivatelEmail || "neznámý uživatel";
  const od = info.zacatek ? ` od ${info.zacatek.toLocaleTimeString("cs-CZ")}` : "";
  return `Právě běží jinde: ${typLabel} (spustil/a ${kdo}${od}). Počkej, až to doběhne, a zkus to pak znovu.`;
}

/**
 * Živě sledovaný stav sdíleného zámku (přes onSnapshot) – appka ho na
 * "/nahrat" ukazuje jako banner, ať uživatel hned vidí, že (a kdo) něco
 * zpracovává, ještě než sám klikne na tlačítko a dostane až pak odmítnutí
 * z ziskejZamek().
 */
export function useZamekStav(): ZamekInfo {
  const [stav, setStav] = useState<ZamekInfo>(PRAZDNY_ZAMEK);

  useEffect(() => {
    const unsub = onSnapshot(lockRef(), (snap) => {
      setStav(mapZamek(snap.exists() ? snap.data() : undefined));
    });
    return () => unsub();
  }, []);

  return stav;
}
