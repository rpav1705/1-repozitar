/**
 * JEDNORÁZOVÝ opravný skript (Node + Firebase Admin SDK) – doplní "termín"
 * (a ostatní z revizní zprávy odvozená pole) v "planovane_revize" u zařízení,
 * která už MAJÍ zpracovanou revizní zprávu s termínem v "revizni_zpravy", ale
 * v plánu zůstala v "chybí termín" (nebo s needitovaným termínem z .xls
 * plánu) – typicky proto, že reimport .xls plánu tenhle termín přepsal
 * zpátky na null/"chybi_termin" (viz oprava v handleSave, app/nahrat/page.tsx:
 * PlanUpload teď reimport plánu u zařízení se zpracovanou revizní zprávou
 * nechává termin/stav beze změny).
 *
 * Na rozdíl od scripts/reprocess-all-revizni-zpravy.ts NESTAHUJE ani znovu
 * NEPARSUJE žádné PDF – jen přepočítá "planovane_revize" z toho, co už je
 * uložené v "revizni_zpravy" (mirror synchronizujPlanovanouRevizi v
 * lib/revizniZpravyHistorie.ts, ale bez mazání historie nad HISTORIE_LIMIT,
 * to už jednou proběhlo při zpracování zprávy a tady ho není potřeba
 * opakovat). Bezpečné pustit víckrát – výsledek nezávisí na počtu spuštění.
 *
 * Spuštění (stejně jako scripts/reprocess-all-revizni-zpravy.ts):
 *   export GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service-account-key.json"
 *   npx tsx scripts/backfill-termin-z-revizni-zpravy.ts
 */

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, Timestamp, Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";

const PLANOVANE_REVIZE_COLLECTION = "planovane_revize";
const REVIZNI_ZPRAVY_COLLECTION = "revizni_zpravy";
/** Musí sedět s lib/revizniZpravyHistorie.ts (HISTORIE_LIMIT). */
const HISTORIE_LIMIT = 2;
const REPROCESS_MARKER_FIELD = "naposledy_zpracovano_reprocessem";

function initFirebase(): Firestore {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      "Chybí proměnná prostředí GOOGLE_APPLICATION_CREDENTIALS – nastav ji na cestu ke " +
        "staženému service account JSON klíči a spusť znovu."
    );
    process.exit(1);
  }
  initializeApp({ credential: applicationDefault() });
  return getFirestore();
}

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

/** Zrcadlí kalendarniDenUTC v lib/revizniZpravyHistorie.ts. */
function kalendarniDenUTC(datum: Date): number {
  return Date.UTC(datum.getUTCFullYear(), datum.getUTCMonth(), datum.getUTCDate());
}

/** Zrcadlí slouzDuplicity v lib/revizniZpravyHistorie.ts – vezme jen tu s novější "poslední úpravou". */
function vyberUnikatni(radky: Radek[]): Radek[] {
  const podleData = new Map<number, Radek[]>();
  for (const radek of radky) {
    const klic = kalendarniDenUTC(radek.datumProvedeni);
    const skupina = podleData.get(klic) ?? [];
    skupina.push(radek);
    podleData.set(klic, skupina);
  }

  const unikatni: Radek[] = [];
  for (const skupina of podleData.values()) {
    if (skupina.length === 1) {
      unikatni.push(skupina[0]);
      continue;
    }
    const serazena = [...skupina].sort(
      (a, b) => poslednUpravaMillis(b.snap.data()) - poslednUpravaMillis(a.snap.data())
    );
    unikatni.push(serazena[0]);
  }
  return unikatni;
}

async function main() {
  const db = initFirebase();

  console.log("Načítám všechny revizní zprávy…");
  const revSnap = await db.collection(REVIZNI_ZPRAVY_COLLECTION).get();

  const podleZarizeni = new Map<string, Radek[]>();
  for (const snap of revSnap.docs) {
    const cislo = snap.data().cislo_zarizeni;
    const datumProvedeni = toDate(snap.data().datum_provedeni);
    if (typeof cislo !== "string" || !cislo || !datumProvedeni) continue;
    const skupina = podleZarizeni.get(cislo) ?? [];
    skupina.push({ snap, datumProvedeni });
    podleZarizeni.set(cislo, skupina);
  }
  console.log(`${revSnap.docs.length} zpráv, ${podleZarizeni.size} různých čísel zařízení.`);

  let zkontrolovano = 0;
  let opraveno = 0;
  let bezShody = 0;
  let jizVPoradku = 0;
  const opravenaZarizeni: string[] = [];

  for (const [cislo, radkyRaw] of podleZarizeni) {
    const radky = vyberUnikatni(radkyRaw).sort(
      (a, b) => b.datumProvedeni.getTime() - a.datumProvedeni.getTime()
    );
    const ponechane = radky.slice(0, HISTORIE_LIMIT);
    const [nejnovejsi, predchozi] = ponechane;
    const novyTermin = toDate(nejnovejsi.snap.data().novy_termin);
    if (!novyTermin) continue;

    const planSnap = await db
      .collection(PLANOVANE_REVIZE_COLLECTION)
      .where("cislo_zarizeni", "==", cislo)
      .get();
    if (planSnap.docs.length !== 1) {
      if (planSnap.docs.length === 0) bezShody += 1;
      continue;
    }
    zkontrolovano += 1;

    const planRef = planSnap.docs[0].ref;
    const planData = planSnap.docs[0].data();

    const uzOdpovida =
      planData.termin instanceof Timestamp &&
      planData.termin.toMillis() === Timestamp.fromDate(novyTermin).toMillis() &&
      planData.posledni_revizni_zprava_id === nejnovejsi.snap.id;
    if (uzOdpovida) {
      jizVPoradku += 1;
      continue;
    }

    const nejnovejsiData = nejnovejsi.snap.data();
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

    opraveno += 1;
    opravenaZarizeni.push(cislo);
    console.log(`  opraveno: ${cislo} -> termín ${novyTermin.toISOString().slice(0, 10)}`);
  }

  console.log("\n===== Souhrn =====");
  console.log(`Zařízení s revizní zprávou a přesně 1 shodou v plánu: ${zkontrolovano}`);
  console.log(`  už v pořádku (termín v plánu odpovídal): ${jizVPoradku}`);
  console.log(`  opraveno: ${opraveno}`);
  console.log(`Zařízení s revizní zprávou, ale BEZ shody v plánu (přeskočeno): ${bezShody}`);
  if (opravenaZarizeni.length > 0) {
    console.log(`\nOpravená čísla zařízení (${opravenaZarizeni.length}):`);
    console.log(opravenaZarizeni.join(", "));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nSkript selhal:", err);
    process.exit(1);
  });
