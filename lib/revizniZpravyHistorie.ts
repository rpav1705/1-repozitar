import {
  collection,
  deleteDoc,
  doc,
  DocumentData,
  getDoc,
  getDocs,
  query,
  QueryDocumentSnapshot,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { deleteObject, ref } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { REPROCESS_MARKER_FIELD } from "@/lib/revizniZpravyFirestore";

/**
 * Kolik posledních revizních zpráv (podle "datum_provedeni", sestupně) appka
 * u každého zařízení uchovává – zbytek se při synchronizaci historie smaže,
 * jak záznam v kolekci "revizni_zpravy", tak PDF ve Firebase Storage.
 */
export const HISTORIE_LIMIT = 2;

export type VysledekSynchronizace = {
  smazanoZaznamu: number;
  smazanoSouboru: number;
  /** Kolik ze smazanoZaznamu bylo konkrétně duplicit (stejné datum provedení jako jiná ponechaná zpráva). */
  duplicitSmazano: number;
  /** Jestli existuje přesně jeden spárovaný záznam v "planovane_revize" a byl přepsán. */
  planSynchronizovan: boolean;
};

function toDate(value: unknown): Date | null {
  return value instanceof Timestamp ? value.toDate() : null;
}

type Radek = { snap: QueryDocumentSnapshot<DocumentData>; datumProvedeni: Date };

/**
 * "Poslední úprava" záznamu jako číslo (ms) pro porovnání duplicit – novější
 * z naposledy_zpracovano_reprocessem (appka ho dřív mohla přeparsovat s
 * opravenou logikou) a nahrano (appka ho vždycky nastaví při uploadu).
 * Chybějící pole se počítá jako nekonečně staré, ne jako chyba.
 */
function poslednUpravaMillis(data: DocumentData): number {
  const kandidati = [data[REPROCESS_MARKER_FIELD], data.nahrano]
    .filter((v): v is Timestamp => v instanceof Timestamp)
    .map((t) => t.toMillis());
  return kandidati.length > 0 ? Math.max(...kandidati) : -Infinity;
}

/**
 * Sloučí záznamy se STEJNÝM datem provedení (duplicity – ať vznikly
 * duplicitním nahráním/zpracováním stejné revize před zavedením stabilního
 * ID zápisu v revizni_zpravy, viz revizniZpravaDocId, nebo jakkoli jinak) do
 * jednoho: ponechá ten s novější "poslední úpravou", ostatní vrátí ke
 * smazání. Bez týhle deduplikace by dvě zprávy se STEJNÝM datem mohly
 * skončit jedna jako "aktuální" a druhá jako "předchozí" zároveň, místo aby
 * "předchozí" ukazovala na skutečně jinou (starší) revizi.
 */
function slouzDuplicity(radky: Radek[]): { unikatni: Radek[]; duplicitni: Radek[] } {
  const podleData = new Map<number, Radek[]>();
  for (const radek of radky) {
    const klic = radek.datumProvedeni.getTime();
    const skupina = podleData.get(klic) ?? [];
    skupina.push(radek);
    podleData.set(klic, skupina);
  }

  const unikatni: Radek[] = [];
  const duplicitni: Radek[] = [];
  for (const skupina of podleData.values()) {
    if (skupina.length === 1) {
      unikatni.push(skupina[0]);
      continue;
    }
    const serazena = [...skupina].sort(
      (a, b) => poslednUpravaMillis(b.snap.data()) - poslednUpravaMillis(a.snap.data())
    );
    unikatni.push(serazena[0]);
    duplicitni.push(...serazena.slice(1));
  }
  return { unikatni, duplicitni };
}

/**
 * Smaže dané záznamy v "revizni_zpravy" a k nim patřící PDF ve Storage –
 * soubor jen když už na něj neodkazuje žádná JINÁ zpráva (jeden nahraný PDF
 * může obsahovat revize pro víc zařízení na různých stránkách). Sdílené mezi
 * synchronizujHistoriiZarizeni (mazání nad HISTORIE_LIMIT) a
 * smazNeaktivniZarizeni (mazání úplně všech zpráv zařízení).
 */
async function smazZpravy(
  docs: QueryDocumentSnapshot<DocumentData>[]
): Promise<{ smazanoZaznamu: number; smazanoSouboru: number }> {
  let smazanoZaznamu = 0;
  let smazanoSouboru = 0;

  for (const d of docs) {
    const storagePath = d.data().pdf_storage_path;
    const path = typeof storagePath === "string" ? storagePath : null;

    await deleteDoc(d.ref);
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

  return { smazanoZaznamu, smazanoSouboru };
}

/**
 * Prořízne historii revizních zpráv daného čísla zařízení na posledních
 * HISTORIE_LIMIT (podle data provedení, sestupně) a starší smaže – jak
 * Firestore záznam v "revizni_zpravy", tak PDF ve Storage (soubor se maže
 * jen když už na něj neodkazuje žádná jiná ponechaná zpráva – jeden nahraný
 * PDF může obsahovat revize pro víc zařízení na různých stránkách). Před
 * oříznutím navíc slouzDuplicity() sloučí záznamy se stejným datem provedení
 * do jednoho (viz tam) – jinak by appka duplicitní zprávu mohla ukázat jako
 * "aktuální" i "předchozí" zároveň, i když jde o tutéž revizi.
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

  const vsechnyRadky: Radek[] = revSnap.docs
    .map((snap) => ({ snap, datumProvedeni: toDate(snap.data().datum_provedeni) }))
    .filter((r): r is Radek => r.datumProvedeni !== null);

  // Duplicity (stejné datum provedení) se sloučí PŘED seřazením/oříznutím na
  // HISTORIE_LIMIT – jinak by se mohly obě dostat do "ponechane" a appka by
  // je ukázala jako aktuální i předchozí zprávu zároveň, viz slouzDuplicity.
  const { unikatni, duplicitni } = slouzDuplicity(vsechnyRadky);
  const radky = unikatni.sort((a, b) => b.datumProvedeni.getTime() - a.datumProvedeni.getTime());

  const ponechane = radky.slice(0, HISTORIE_LIMIT);
  const kSmazani = [...radky.slice(HISTORIE_LIMIT), ...duplicitni];

  const { smazanoZaznamu, smazanoSouboru } = await smazZpravy(kSmazani.map((r) => r.snap));
  const planSynchronizovan = await synchronizujPlanovanouRevizi(cisloZarizeni, ponechane);

  return { smazanoZaznamu, smazanoSouboru, duplicitSmazano: duplicitni.length, planSynchronizovan };
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
    vysledek_revize: nejnovejsiData.vysledek_revize ?? null,
    zjistena_zavada: nejnovejsiData.zjistena_zavada ?? null,
    predchozi_revizni_zprava_url: predchozi ? predchozi.snap.data().pdf_url ?? null : null,
    predchozi_revizni_zprava_id: predchozi ? predchozi.snap.id : null,
    predchozi_datum_provedeni: predchozi ? Timestamp.fromDate(predchozi.datumProvedeni) : null,
  });

  return true;
}

export type VysledekMazaniNeaktivniho = {
  /** Jestli záznam v "planovane_revize" s tímhle ID vůbec existoval a byl smazán. */
  planSmazan: boolean;
  smazanoZaznamu: number;
  smazanoSouboru: number;
};

/**
 * Smaže záznam v "planovane_revize" pro dané zařízení (identifikované PU
 * odvozeným ID dokumentu – stejné ID, podle kterého import .xls záznamy
 * upsertuje). Jedno číslo zařízení může mít víc záznamů v plánu (víc typů
 * revize, různá PÚ) – revizní zprávy jsou ale spárované jen podle čísla
 * zařízení, ne podle konkrétního PÚ, takže by jejich smazáním mohly přijít
 * o data i zprávy patřící k JINÉMU, pořád aktivnímu typu revize stejného
 * zařízení. Revizní zprávy (Firestore i PDF ve Storage) se proto smažou jen
 * tehdy, když po smazání téhle plánované revize u čísla zařízení nezůstal
 * v plánu už VŮBEC ŽÁDNÝ jiný záznam.
 *
 * Používá se pro řádky z importu .xls se sloupcem "Stav" = "INACTIVE" (viz
 * lib/xlsxImport.ts) – appka taková zařízení dál v sobě nedrží.
 */
export async function smazNeaktivniZarizeni(
  planDocId: string,
  cisloZarizeni: string
): Promise<VysledekMazaniNeaktivniho> {
  const planRef = doc(db, "planovane_revize", planDocId);
  const planSnap = await getDoc(planRef);
  if (!planSnap.exists()) {
    return { planSmazan: false, smazanoZaznamu: 0, smazanoSouboru: 0 };
  }

  await deleteDoc(planRef);

  const zbyleSnap = await getDocs(
    query(collection(db, "planovane_revize"), where("cislo_zarizeni", "==", cisloZarizeni))
  );
  if (!zbyleSnap.empty) {
    return { planSmazan: true, smazanoZaznamu: 0, smazanoSouboru: 0 };
  }

  const revSnap = await getDocs(
    query(collection(db, "revizni_zpravy"), where("cislo_zarizeni", "==", cisloZarizeni))
  );
  const { smazanoZaznamu, smazanoSouboru } = await smazZpravy(revSnap.docs);

  return { planSmazan: true, smazanoZaznamu, smazanoSouboru };
}
