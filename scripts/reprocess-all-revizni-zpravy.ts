/**
 * Jednorázové/hromadné přeparsování VŠECH uložených revizních zpráv –
 * spouští se ručně v terminálu (Node + Firebase Admin SDK), NE v prohlížeči.
 * Vznikl proto, že tlačítko "Zpracovat znovu úplně vše" v app/nahrat/page.tsx
 * u fronty ~1881 souborů opakovaně dokázalo zaseknout kartu prohlížeče
 * ("Stránka nereaguje") i po opravě vracení řízení event loopu – jde o
 * principiálně křehký přístup (tisíce PDF na jednom vlákně v otevřené
 * kartě). Tenhle skript dělá STEJNOU práci jako to tlačítko (mód "úplně
 * vše"), ale běží jako obyčejný Node proces bez UI, takže žádný "tab
 * frozen"/timeout problém nehrozí. Běžné/malé dávky (řádově desítky nových
 * zpráv) ať appka dál zpracovává přes tlačítko v prohlížeči – na to stačí.
 *
 * Konkrétně (stejně jako tlačítko, mód "vse"):
 *   1. Projde všechny záznamy v "revizni_zpravy", vybere jen AKTUÁLNÍ
 *      (nejnovější dle datum_provedeni) zprávu za každé číslo zařízení.
 *   2. Seskupí je podle pdf_storage_path (jeden PDF může mít víc stránek =
 *      víc zařízení) a soubor stáhne jen jednou za skupinu.
 *   3. Naparsuje PDF STEJNOU parsovací logikou jako appka – importuje přímo
 *      lib/pdfRevizniZprava.ts (parseRevizniZpravyPdf), nic nekopíruje. Tenhle
 *      modul kvůli tomu používá "legacy" build pdfjs-dist (funguje beze
 *      změny v prohlížeči i v Node) a workerSrc si podle prostředí nastaví
 *      sám (viz ensureWorker() tamtéž).
 *   4. Přepíše naparsovaná pole zpět do Firestore (u úspěchu) a označí
 *      zprávu marker polem "naposledy_zpracovano_reprocessem", stejně jako
 *      appka.
 *   5. U každého dotčeného čísla zařízení pak nejdřív sloučí záznamy se
 *      STEJNÝM datem provedení (duplicity – typicky z doby, než zápis nových
 *      zpráv začal používat stabilní ID, viz revizniZpravaDocId v
 *      lib/revizniZpravyFirestore.ts), pak zkrátí historii na poslední
 *      HISTORIE_LIMIT záznamy (starší i duplicitní smaže i s PDF ve Storage)
 *      a dosadí výsledek do "planovane_revize" – tahle část zrcadlí algoritmus
 *      z lib/revizniZpravyHistorie.ts (synchronizujHistoriiZarizeni). Nejde
 *      odtud přímo naimportovat, protože ten soubor používá KLIENTSKÝ
 *      "firebase/firestore" SDK (Timestamp/Firestore instance neslučitelné s
 *      "firebase-admin/firestore") – při změně algoritmu tam je potřeba
 *      upravit i tuhle kopii níž (synchronizujHistoriiZarizeniAdmin,
 *      slouzDuplicity, poslednUpravaMillis).
 *
 * Jedno selhání souboru/zařízení (chyba stažení, parsování, zápisu) NEZASTAVÍ
 * celý běh – zaloguje se a pokračuje se dál (viz Vysledky.zaznamChybu a
 * try/catch v pruneWorker). Skript NEMÁ checkpoint/resume mezi jednotlivými
 * spuštěními, ale je bezpečné ho po přerušení pustit znovu od začátku –
 * přeparsování i prořezání historie jsou idempotentní (výsledek nezávisí na
 * tom, kolikrát proběhly).
 *
 * Spuštění:
 *   1. Firebase Console -> Project settings -> Service accounts ->
 *      "Generate new private key" -> stáhne se JSON.
 *   2. Ulož ho v Codespace jako `service-account-key.json` v kořeni repa
 *      (přesně tenhle název/vzor je v .gitignore, takže se nikdy neco commitne).
 *   3. export GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service-account-key.json"
 *   4. npm run reprocess-all   (nebo přímo: npx tsx scripts/reprocess-all-revizni-zpravy.ts)
 *
 * REPROCESS_INCLUDE_HISTORII=1 npm run reprocess-all – jednorázový režim,
 * který přeparsuje ÚPLNĚ VŠECHNY uložené zprávy (i historické/starší, ne
 * jen aktuální za každé zařízení). Použij po opravě, která mění, jak appka
 * data počítá (typicky časová zóna v datu provedení, viz lib/parseDate.ts),
 * ať se opravená logika projeví i na už dřív uložených historických datech.
 */

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, Timestamp, Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { parseRevizniZpravyPdf, ParsedRevizniZprava } from "../lib/pdfRevizniZprava";
import { REPROCESS_MARKER_FIELD } from "../lib/revizniZpravyFirestore";

type Bucket = ReturnType<ReturnType<typeof getStorage>["bucket"]>;

const STORAGE_BUCKET = "repozitar-7f22a.firebasestorage.app";
const REVIZNI_ZPRAVY_COLLECTION = "revizni_zpravy";
const PLANOVANE_REVIZE_COLLECTION = "planovane_revize";
/** Musí sedět s lib/revizniZpravyHistorie.ts (HISTORIE_LIMIT). */
const HISTORIE_LIMIT = 2;

const DOWNLOAD_CONCURRENCY = 4;
const PRUNE_CONCURRENCY = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function initFirebase(): Firestore {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      "Chybí proměnná prostředí GOOGLE_APPLICATION_CREDENTIALS – nastav ji na cestu ke " +
        "staženému service account JSON klíči (viz komentář nahoře v tomhle souboru) a spusť znovu."
    );
    process.exit(1);
  }
  initializeApp({
    credential: applicationDefault(),
    storageBucket: STORAGE_BUCKET,
  });
  return getFirestore();
}

// ---------------------------------------------------------------------------
// Výběr aktuálních zpráv a seskupení podle souboru – zrcadlí vyberAktualniZpravy
// a seskupovací smyčku v app/nahrat/page.tsx (RevizniZpravyReprocess).
// ---------------------------------------------------------------------------

function vyberAktualniZpravy(
  docs: QueryDocumentSnapshot[]
): QueryDocumentSnapshot[] {
  const podleZarizeni = new Map<string, QueryDocumentSnapshot[]>();
  const bezCisla: QueryDocumentSnapshot[] = [];

  for (const d of docs) {
    const cislo = d.data().cislo_zarizeni;
    if (typeof cislo === "string" && cislo) {
      const skupina = podleZarizeni.get(cislo) ?? [];
      skupina.push(d);
      podleZarizeni.set(cislo, skupina);
    } else {
      bezCisla.push(d);
    }
  }

  const aktualniDatum = (d: QueryDocumentSnapshot) => {
    const hodnota = d.data().datum_provedeni;
    return hodnota instanceof Timestamp ? hodnota.toMillis() : -Infinity;
  };

  const vybrane = [...bezCisla];
  for (const skupina of podleZarizeni.values()) {
    vybrane.push(
      skupina.reduce((nejnovejsi, d) => (aktualniDatum(d) > aktualniDatum(nejnovejsi) ? d : nejnovejsi))
    );
  }
  return vybrane;
}

// ---------------------------------------------------------------------------
// Zrcadlí revizniZpravaToFirestoreFields z lib/revizniZpravyFirestore.ts –
// nejde přímo importovat, protože ten soubor staví Timestamp z klientského
// "firebase/firestore" SDK, ne z "firebase-admin/firestore" (jiná třída,
// Admin SDK cizí instanci při zápisu odmítne). Při přidání dalšího pole tam
// přidej stejné pole i sem.
// ---------------------------------------------------------------------------

function toFirestoreFieldsAdmin(zprava: ParsedRevizniZprava) {
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

// ---------------------------------------------------------------------------
// Sběr výsledků a průběžné logování do konzole.
// ---------------------------------------------------------------------------

class Vysledky {
  zpracovano = 0;
  uspesne = 0;
  chyba = 0;
  ok = 0;
  nok = 0;
  keKontrole = 0;
  readonly dotcenaZarizeni = new Set<string>();
  readonly chybyDetail: string[] = [];

  constructor(private readonly total: number) {}

  private logProgress() {
    if (this.zpracovano % 25 === 0 || this.zpracovano === this.total) {
      console.log(`Zpracováno ${this.zpracovano}/${this.total}…`);
    }
  }

  zaznamUspech(zprava: ParsedRevizniZprava) {
    this.zpracovano += 1;
    this.uspesne += 1;
    if (zprava.cislo_zarizeni) this.dotcenaZarizeni.add(zprava.cislo_zarizeni);
    if (zprava.vysledek_revize === "OK") this.ok += 1;
    else if (zprava.vysledek_revize === "NOK") this.nok += 1;
    else this.keKontrole += 1;
    this.logProgress();
  }

  zaznamChybu(cisloZarizeni: string, soubor: string, stranka: number, poznamka: string) {
    this.zpracovano += 1;
    this.chyba += 1;
    if (cisloZarizeni) this.dotcenaZarizeni.add(cisloZarizeni);
    const popis = `${soubor} (strana ${stranka}, zařízení ${cisloZarizeni || "?"}): ${poznamka}`;
    this.chybyDetail.push(popis);
    console.error(`  CHYBA: ${popis}`);
    this.logProgress();
  }

  vytiskniSouhrn(pruneSouhrn: {
    zarizeni: number;
    zarizeniSMazanim: number;
    zarizeniSDuplicitou: number;
    smazanoZaznamu: number;
    smazanoSouboru: number;
    duplicitSmazano: number;
  }) {
    console.log("\n===== Souhrn reparsování =====");
    console.log(`Zpracováno celkem: ${this.zpracovano}`);
    console.log(`  úspěšně: ${this.uspesne}`);
    console.log(`  chyba: ${this.chyba}`);
    console.log("Výsledek revize (u úspěšně zpracovaných):");
    console.log(`  OK: ${this.ok}`);
    console.log(`  NOK: ${this.nok}`);
    console.log(`  KE_KONTROLE: ${this.keKontrole}`);
    if (this.chybyDetail.length > 0) {
      console.log(`\nChyby (${this.chybyDetail.length}):`);
      for (const radek of this.chybyDetail) console.log(`  - ${radek}`);
    }
    console.log("\n===== Souhrn prořezání historie =====");
    console.log(`Dotčených zařízení: ${pruneSouhrn.zarizeni}`);
    console.log(`  s mazáním: ${pruneSouhrn.zarizeniSMazanim}`);
    console.log(`  s duplicitní revizí (stejné datum provedení): ${pruneSouhrn.zarizeniSDuplicitou}`);
    console.log(`  smazáno záznamů celkem: ${pruneSouhrn.smazanoZaznamu}`);
    console.log(`    z toho duplicit: ${pruneSouhrn.duplicitSmazano}`);
    console.log(`  smazáno souborů: ${pruneSouhrn.smazanoSouboru}`);
  }
}

// ---------------------------------------------------------------------------
// Reparsování jedné skupiny (= jeden PDF soubor, může obsahovat víc zařízení)
// – zrcadlí processGroup v app/nahrat/page.tsx.
// ---------------------------------------------------------------------------

async function zpracujSkupinu(
  db: Firestore,
  bucket: Bucket,
  storagePath: string,
  groupDocs: QueryDocumentSnapshot[],
  vysledky: Vysledky
) {
  // Malá náhodná prodleva před každým stažením – rozloží špičky, stejně jako
  // v processGroup v appce (viz komentář tam k "storage/retry-limit-exceeded").
  await sleep(100 + Math.random() * 200);

  let freshByStranka: Map<number, ParsedRevizniZprava> | null = null;
  let downloadError = "";
  try {
    const [buffer] = await bucket.file(storagePath).download();
    // .slice() na Uint8Array vrátí kopii podloženou čerstvým ArrayBufferem
    // (ne sdíleným/pooled bufferem Node Bufferu) – parseRevizniZpravyPdf
    // (resp. pdf.js) potřebuje vlastnit svoji vlastní kopii dat.
    const arrayBuffer = new Uint8Array(buffer).slice().buffer;
    const { zpravy } = await parseRevizniZpravyPdf(arrayBuffer);
    freshByStranka = new Map(zpravy.map((z) => [z.stranka, z]));
  } catch (err) {
    downloadError = err instanceof Error ? err.message : "nepodařilo se stáhnout soubor ze Storage";
  }

  for (const docSnap of groupDocs) {
    const data = docSnap.data();
    const soubor = typeof data.soubor_nazev === "string" ? data.soubor_nazev : storagePath;
    const stranka = typeof data.stranka === "number" ? data.stranka : 0;
    const cisloPuvodni = typeof data.cislo_zarizeni === "string" ? data.cislo_zarizeni : "";

    const fresh = freshByStranka?.get(stranka);

    if (downloadError) {
      vysledky.zaznamChybu(cisloPuvodni, soubor, stranka, downloadError);
      continue;
    }
    if (!fresh) {
      vysledky.zaznamChybu(
        cisloPuvodni,
        soubor,
        stranka,
        "stránka se po přeparsování nepodařila znovu rozpoznat"
      );
      continue;
    }
    if (fresh.cislo_zarizeni !== cisloPuvodni) {
      vysledky.zaznamChybu(
        cisloPuvodni,
        soubor,
        stranka,
        `číslo zařízení se po přeparsování změnilo (${cisloPuvodni} → ${fresh.cislo_zarizeni}) – přeskočeno`
      );
      continue;
    }

    try {
      await docSnap.ref.update({
        ...toFirestoreFieldsAdmin(fresh),
        [REPROCESS_MARKER_FIELD]: Timestamp.now(),
      });
      vysledky.zaznamUspech(fresh);
    } catch (err) {
      vysledky.zaznamChybu(
        cisloPuvodni,
        soubor,
        stranka,
        err instanceof Error ? err.message : "nepodařilo se zapsat do Firestore"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Prořezání historie + sync "planovane_revize" – zrcadlí
// lib/revizniZpravyHistorie.ts (synchronizujHistoriiZarizeni), přepsáno pro
// Admin SDK. Při změně algoritmu tam uprav i tady.
// ---------------------------------------------------------------------------

type Radek = { snap: QueryDocumentSnapshot; datumProvedeni: Date };

function toDate(value: unknown): Date | null {
  return value instanceof Timestamp ? value.toDate() : null;
}

/** Zrcadlí poslednUpravaMillis v lib/revizniZpravyHistorie.ts. */
function poslednUpravaMillis(data: FirebaseFirestore.DocumentData): number {
  const kandidati = [data[REPROCESS_MARKER_FIELD], data.nahrano]
    .filter((v): v is Timestamp => v instanceof Timestamp)
    .map((t) => t.toMillis());
  return kandidati.length > 0 ? Math.max(...kandidati) : -Infinity;
}

/**
 * Zrcadlí kalendarniDenUTC v lib/revizniZpravyHistorie.ts – kalendářní den v
 * UTC, ne přesná shoda Timestampu (viz vysvětlení tam a u parseFlexibleDate
 * v lib/parseDate.ts: appka v prohlížeči i tenhle Node skript dřív pro
 * STEJNÉ nominální datum ukládaly Timestampy hodinu od sebe).
 */
function kalendarniDenUTC(datum: Date): number {
  return Date.UTC(datum.getUTCFullYear(), datum.getUTCMonth(), datum.getUTCDate());
}

/** Zrcadlí slouzDuplicity v lib/revizniZpravyHistorie.ts. */
function slouzDuplicity(radky: Radek[]): { unikatni: Radek[]; duplicitni: Radek[] } {
  const podleData = new Map<number, Radek[]>();
  for (const radek of radky) {
    const klic = kalendarniDenUTC(radek.datumProvedeni);
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

async function smazZpravyAdmin(
  db: Firestore,
  bucket: Bucket,
  docs: QueryDocumentSnapshot[]
): Promise<{ smazanoZaznamu: number; smazanoSouboru: number }> {
  let smazanoZaznamu = 0;
  let smazanoSouboru = 0;

  for (const d of docs) {
    const storagePath = d.data().pdf_storage_path;
    const path = typeof storagePath === "string" ? storagePath : null;

    await d.ref.delete();
    smazanoZaznamu += 1;

    if (path) {
      const jesteUzito = await db
        .collection(REVIZNI_ZPRAVY_COLLECTION)
        .where("pdf_storage_path", "==", path)
        .get();
      if (jesteUzito.empty) {
        try {
          await bucket.file(path).delete();
          smazanoSouboru += 1;
        } catch {
          // Soubor už ve Storage nemusí existovat – nekritické, viz
          // stejná poznámka v lib/revizniZpravyHistorie.ts.
        }
      }
    }
  }

  return { smazanoZaznamu, smazanoSouboru };
}

async function synchronizujPlanovanouReviziAdmin(
  db: Firestore,
  cisloZarizeni: string,
  ponechane: Radek[]
): Promise<boolean> {
  if (ponechane.length === 0) return false;

  const planSnap = await db
    .collection(PLANOVANE_REVIZE_COLLECTION)
    .where("cislo_zarizeni", "==", cisloZarizeni)
    .get();
  if (planSnap.docs.length !== 1) return false;

  const [nejnovejsi, predchozi] = ponechane;
  const nejnovejsiData = nejnovejsi.snap.data();
  const novyTermin = toDate(nejnovejsiData.novy_termin);
  if (!novyTermin) return false;

  const planRef = planSnap.docs[0].ref;
  const planData = planSnap.docs[0].data();

  const jeUzAktualni = planData.posledni_revizni_zprava_id === nejnovejsi.snap.id;
  const predchoziTermin = predchozi ? toDate(predchozi.snap.data().novy_termin) : null;
  const posledniRevizeVcas = jeUzAktualni
    ? typeof planData.posledni_revize_vcas === "boolean"
      ? planData.posledni_revize_vcas
      : null
    : predchoziTermin
      ? nejnovejsi.datumProvedeni <= predchoziTermin
      : null;

  await planRef.update({
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
    predchozi_revizni_zprava_url: predchozi ? (predchozi.snap.data().pdf_url ?? null) : null,
    predchozi_revizni_zprava_id: predchozi ? predchozi.snap.id : null,
    predchozi_datum_provedeni: predchozi ? Timestamp.fromDate(predchozi.datumProvedeni) : null,
  });

  return true;
}

async function synchronizujHistoriiZarizeniAdmin(
  db: Firestore,
  bucket: Bucket,
  cisloZarizeni: string
): Promise<{
  smazanoZaznamu: number;
  smazanoSouboru: number;
  duplicitSmazano: number;
  planSynchronizovan: boolean;
}> {
  const revSnap = await db
    .collection(REVIZNI_ZPRAVY_COLLECTION)
    .where("cislo_zarizeni", "==", cisloZarizeni)
    .get();

  const vsechnyRadky: Radek[] = revSnap.docs
    .map((snap) => ({ snap, datumProvedeni: toDate(snap.data().datum_provedeni) }))
    .filter((r): r is Radek => r.datumProvedeni !== null);

  // Duplicity (stejné datum provedení) se sloučí PŘED oříznutím na
  // HISTORIE_LIMIT – viz slouzDuplicity a stejný komentář u
  // lib/revizniZpravyHistorie.ts::synchronizujHistoriiZarizeni.
  const { unikatni, duplicitni } = slouzDuplicity(vsechnyRadky);
  const radky = unikatni.sort((a, b) => b.datumProvedeni.getTime() - a.datumProvedeni.getTime());

  const ponechane = radky.slice(0, HISTORIE_LIMIT);
  const kSmazani = [...radky.slice(HISTORIE_LIMIT), ...duplicitni];

  const { smazanoZaznamu, smazanoSouboru } = await smazZpravyAdmin(
    db,
    bucket,
    kSmazani.map((r) => r.snap)
  );
  const planSynchronizovan = await synchronizujPlanovanouReviziAdmin(db, cisloZarizeni, ponechane);

  return { smazanoZaznamu, smazanoSouboru, duplicitSmazano: duplicitni.length, planSynchronizovan };
}

// ---------------------------------------------------------------------------

async function main() {
  const db = initFirebase();
  const bucket = getStorage().bucket();

  // Normálně appka (tlačítko i tenhle skript) přeparsovává jen AKTUÁLNÍ
  // (nejnovější) zprávu za každé zařízení – historické/starší zprávy se
  // znovu nestahují, viz komentář u vyberAktualniZpravy. REPROCESS_INCLUDE_HISTORII=1
  // tenhle filtr přeskočí a projde ÚPLNĚ VŠECHNY uložené zprávy (i historické) –
  // použij to jen jednorázově po opravě, která mění, jak appka data/ID
  // počítá (např. oprava časové zóny v datu provedení, viz lib/parseDate.ts),
  // ať se historická data přepočítají/normalizují nově opravenou logikou
  // všude, ne jen u zrovna aktuálních zpráv.
  const zahrnoutHistorii = process.env.REPROCESS_INCLUDE_HISTORII === "1";

  console.log("Načítám seznam uložených revizních zpráv…");
  const snap = await db.collection(REVIZNI_ZPRAVY_COLLECTION).get();
  const aktualni = zahrnoutHistorii ? snap.docs : vyberAktualniZpravy(snap.docs);
  console.log(
    zahrnoutHistorii
      ? `Nalezeno ${snap.docs.length} záznamů celkem – REPROCESS_INCLUDE_HISTORII=1, zpracují se VŠECHNY (i historické).`
      : `Nalezeno ${snap.docs.length} záznamů celkem, z toho ${aktualni.length} aktuálních (po jedné na zařízení).`
  );

  const groups = new Map<string, QueryDocumentSnapshot[]>();
  for (const d of aktualni) {
    const path = d.data().pdf_storage_path;
    if (typeof path !== "string") continue;
    const group = groups.get(path) ?? [];
    group.push(d);
    groups.set(path, group);
  }

  const vysledky = new Vysledky(aktualni.length);
  const entries = Array.from(groups.entries());
  console.log(`Souborů ke stažení: ${entries.length} (souběžnost ${DOWNLOAD_CONCURRENCY}).\n`);

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < entries.length) {
      const idx = nextIndex;
      nextIndex += 1;
      const [storagePath, groupDocs] = entries[idx];
      await zpracujSkupinu(db, bucket, storagePath, groupDocs, vysledky);
    }
  }
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, () => worker()));

  console.log("\nReparsování hotové. Prořezávám historii a synchronizuji plánované revize…");

  const zarizeniList = Array.from(vysledky.dotcenaZarizeni);
  const pruneSouhrn = {
    zarizeni: zarizeniList.length,
    zarizeniSMazanim: 0,
    zarizeniSDuplicitou: 0,
    smazanoZaznamu: 0,
    smazanoSouboru: 0,
    duplicitSmazano: 0,
  };
  let nextPruneIndex = 0;
  let pruneDone = 0;
  async function pruneWorker() {
    while (nextPruneIndex < zarizeniList.length) {
      const idx = nextPruneIndex;
      nextPruneIndex += 1;
      const cislo = zarizeniList[idx];
      try {
        const vysledek = await synchronizujHistoriiZarizeniAdmin(db, bucket, cislo);
        if (vysledek.smazanoZaznamu > 0) pruneSouhrn.zarizeniSMazanim += 1;
        if (vysledek.duplicitSmazano > 0) pruneSouhrn.zarizeniSDuplicitou += 1;
        pruneSouhrn.smazanoZaznamu += vysledek.smazanoZaznamu;
        pruneSouhrn.smazanoSouboru += vysledek.smazanoSouboru;
        pruneSouhrn.duplicitSmazano += vysledek.duplicitSmazano;
      } catch (err) {
        console.error(
          `  prořezání historie zařízení ${cislo} selhalo: ${err instanceof Error ? err.message : err}`
        );
      }
      pruneDone += 1;
      if (pruneDone % 50 === 0 || pruneDone === zarizeniList.length) {
        console.log(`  prořezání historie: ${pruneDone}/${zarizeniList.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: PRUNE_CONCURRENCY }, () => pruneWorker()));

  vysledky.vytiskniSouhrn(pruneSouhrn);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nSkript selhal:", err);
    process.exit(1);
  });
