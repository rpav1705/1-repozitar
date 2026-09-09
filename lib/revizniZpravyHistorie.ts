import {
  collection,
  deleteDoc,
  DocumentData,
  getDocs,
  query,
  QueryDocumentSnapshot,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { deleteObject, ref } from "firebase/storage";
import { db, storage } from "@/lib/firebase";

/**
 * Kolik posledních revizních zpráv (podle "datum_provedeni", sestupně) appka
 * u každého zařízení uchovává – zbytek se při synchronizaci historie smaže,
 * jak záznam v kolekci "revizni_zpravy", tak PDF ve Firebase Storage.
 */
export const HISTORIE_LIMIT = 2;

export type VysledekSynchronizace = {
  smazanoZaznamu: number;
  smazanoSouboru: number;
  /** Jestli existuje přesně jeden spárovaný záznam v "planovane_revize" a byl přepsán. */
  planSynchronizovan: boolean;
};

function toDate(value: unknown): Date | null {
  return value instanceof Timestamp ? value.toDate() : null;
}

type Radek = { snap: QueryDocumentSnapshot<DocumentData>; datumProvedeni: Date };

/**
 * Prořízne historii revizních zpráv daného čísla zařízení na posledních
 * HISTORIE_LIMIT (podle data provedení, sestupně) a starší smaže – jak
 * Firestore záznam v "revizni_zpravy", tak PDF ve Storage (soubor se maže
 * jen když už na něj neodkazuje žádná jiná ponechaná zpráva – jeden nahraný
 * PDF může obsahovat revize pro víc zařízení na různých stránkách).
 *
 * Zároveň dosadí do spárovaného záznamu v "planovane_revize" pole ze
 * SKUTEČNĚ nejnovější ponechané zprávy (ne z té, která byla zpracovaná či
 * nahraná naposled – při dávkovém zpracování nemusí být pořadí souborů
 * shodné s pořadím data provedení) a druhý nejnovější odkaz do
 * "predchozi_*" polí, ať appka může vedle aktuální revizní zprávy zobrazit i
 * tu předchozí.
 *
 * Volá se jak po novém nahrání PDF, tak z tlačítka "Znovu zpracovat uložené
 * revizní zprávy" – tím druhým se dá i jednorázově spustit na už dřív
 * uložených datech.
 */
export async function synchronizujHistoriiZarizeni(
  cisloZarizeni: string
): Promise<VysledekSynchronizace> {
  const revSnap = await getDocs(
    query(collection(db, "revizni_zpravy"), where("cislo_zarizeni", "==", cisloZarizeni))
  );

  const radky: Radek[] = revSnap.docs
    .map((snap) => ({ snap, datumProvedeni: toDate(snap.data().datum_provedeni) }))
    .filter((r): r is Radek => r.datumProvedeni !== null)
    .sort((a, b) => b.datumProvedeni.getTime() - a.datumProvedeni.getTime());

  const ponechane = radky.slice(0, HISTORIE_LIMIT);
  const kSmazani = radky.slice(HISTORIE_LIMIT);

  let smazanoZaznamu = 0;
  let smazanoSouboru = 0;

  for (const radek of kSmazani) {
    const storagePath = radek.snap.data().pdf_storage_path;
    const path = typeof storagePath === "string" ? storagePath : null;

    await deleteDoc(radek.snap.ref);
    smazanoZaznamu += 1;

    if (path) {
      const jesteUzito = await getDocs(
        query(collection(db, "revizni_zpravy"), where("pdf_storage_path", "==", path))
      );
      if (jesteUzito.empty) {
        try {
          await deleteObject(ref(storage, path));
          smazanoSouboru += 1;
        } catch {
          // Soubor už ve Storage nemusí existovat (např. smazaný ručně přes
          // konzoli) – nekritické, Firestore historie je i tak uklizená.
        }
      }
    }
  }

  const planSynchronizovan = await synchronizujPlanovanouRevizi(cisloZarizeni, ponechane);

  return { smazanoZaznamu, smazanoSouboru, planSynchronizovan };
}

async function synchronizujPlanovanouRevizi(
  cisloZarizeni: string,
  ponechane: Radek[]
): Promise<boolean> {
  if (ponechane.length === 0) return false;

  const planSnap = await getDocs(
    query(collection(db, "planovane_revize"), where("cislo_zarizeni", "==", cisloZarizeni))
  );
  // Bez shody nebo víc shod (víc typů revize u stejného čísla zařízení) –
  // stejně jako při párování nic automaticky needitujeme.
  if (planSnap.docs.length !== 1) return false;

  const [nejnovejsi, predchozi] = ponechane;
  const nejnovejsiData = nejnovejsi.snap.data();
  const novyTermin = toDate(nejnovejsiData.novy_termin);
  if (!novyTermin) return false;

  const planRef = planSnap.docs[0].ref;
  const planData = planSnap.docs[0].data();

  // posledni_revize_vcas je historická informace spočtená v okamžiku
  // spárování (porovnání data provedení s tehdy platným termínem) – pokud
  // je nejnovější ponechaná zpráva pořád ta, na kterou plán už ukazuje,
  // necháváme ji beze změny. Jinak (typicky po dávkovém zpracování mimo
  // chronologické pořadí) ji dopočítáme z termínu, který nastavila
  // předchozí ponechaná zpráva.
  const jeUzAktualni = planData.posledni_revizni_zprava_id === nejnovejsi.snap.id;
  const predchoziTermin = predchozi ? toDate(predchozi.snap.data().novy_termin) : null;
  const posledniRevizeVcas = jeUzAktualni
    ? typeof planData.posledni_revize_vcas === "boolean"
      ? planData.posledni_revize_vcas
      : null
    : predchoziTermin
      ? nejnovejsi.datumProvedeni <= predchoziTermin
      : null;

  await updateDoc(planRef, {
    termin: Timestamp.fromDate(novyTermin),
    datum_provedeni: Timestamp.fromDate(nejnovejsi.datumProvedeni),
    technik_jmeno: nejnovejsiData.technik_jmeno ?? null,
    technik_cislo_opravneni: nejnovejsiData.technik_cislo_opravneni ?? null,
    stav: "cekajici",
    posledni_revize_vcas: posledniRevizeVcas,
    posledni_revizni_zprava_url: nejnovejsiData.pdf_url ?? null,
    posledni_revizni_zprava_id: nejnovejsi.snap.id,
    predchozi_revizni_zprava_url: predchozi ? predchozi.snap.data().pdf_url ?? null : null,
    predchozi_revizni_zprava_id: predchozi ? predchozi.snap.id : null,
    predchozi_datum_provedeni: predchozi ? Timestamp.fromDate(predchozi.datumProvedeni) : null,
  });

  return true;
}
