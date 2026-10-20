import { NextRequest, NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { ChybaKonfiguraceFirebase, overitIdToken, ziskejAdminFirestore } from "@/lib/firebaseAdmin";
import { jeDruhRevize, planOdpovidaDruhu } from "@/lib/druhRevize";
import { TYPY_REVIZE } from "@/lib/typRevize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Přehled revizních zpráv nahraných v daném měsíci (pole "nahrano") – za
 * každý druh revizí: kolik zpráv se nahrálo, kolik z nich je AKTUÁLNĚ
 * přiřazeno na přesně jeden záznam plánu (stejné párování jako analýza
 * nespárovaných zpráv, ne snímek "parovani_stav" z doby nahrání), rozpad
 * podle výsledku, dnů a techniků. Počítá se na serveru nad Firestore.
 *
 * Pozn.: appka drží u každého zařízení (a druhu) jen poslední 2 zprávy
 * (viz lib/revizniZpravyHistorie.ts) – zpráva nahraná v tomhle měsíci a
 * mezitím nahrazená novější by v přehledu chyběla.
 */
const ZONA = "Europe/Prague";

function denPraha(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: ZONA }); // YYYY-MM-DD
}

export async function GET(request: NextRequest) {
  try {
    await overitIdToken(request.headers.get("authorization"));
  } catch (err) {
    if (err instanceof ChybaKonfiguraceFirebase) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Neplatný nebo chybějící přihlašovací token." },
      { status: 401 }
    );
  }

  const mesicParam = request.nextUrl.searchParams.get("mesic") ?? denPraha(new Date()).slice(0, 7);
  const m = mesicParam.match(/^(\d{4})-(\d{2})$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
    return NextResponse.json({ error: `Neplatný měsíc: ${mesicParam} (očekáváno RRRR-MM)` }, { status: 400 });
  }
  const rok = Number(m[1]);
  const mesic = Number(m[2]);
  // Dotaz s rezervou den na obě strany (časová zóna), přesné rozhraní měsíce
  // se pak určí podle pražského dne.
  const od = Timestamp.fromDate(new Date(Date.UTC(rok, mesic - 1, 1) - 24 * 3600 * 1000));
  const do_ = Timestamp.fromDate(new Date(Date.UTC(rok, mesic, 1) + 24 * 3600 * 1000));

  try {
    const db = ziskejAdminFirestore();
    const typy = [];

    for (const kolekce of TYPY_REVIZE) {
      const [zpravySnap, planySnap, celkemSnap] = await Promise.all([
        db
          .collection(kolekce.zpravy)
          .where("nahrano", ">=", od)
          .where("nahrano", "<", do_)
          .select(
            "cislo_zarizeni",
            "druh_revize",
            "nahrano",
            "vysledek_revize",
            "technik_jmeno",
            "soubor_nazev",
            "ignorovano",
            "cteno_claude"
          )
          .get(),
        db.collection(kolekce.plan).select("cislo_zarizeni", "frekvence").get(),
        db.collection(kolekce.zpravy).count().get(),
      ]);

      const planyPodleZarizeni = new Map<string, (number | null)[]>();
      for (const d of planySnap.docs) {
        const data = d.data();
        const cislo = typeof data.cislo_zarizeni === "string" ? data.cislo_zarizeni : "";
        if (!cislo) continue;
        const seznam = planyPodleZarizeni.get(cislo) ?? [];
        seznam.push(typeof data.frekvence === "number" ? data.frekvence : null);
        planyPodleZarizeni.set(cislo, seznam);
      }

      let celkem = 0;
      let prirazeno = 0;
      let bezShody = 0;
      let viceShod = 0;
      let ignorovano = 0;
      let chybiCislo = 0;
      let ctenoClaude = 0;
      const vysledky = { OK: 0, NOK: 0, KE_KONTROLE: 0, nezname: 0 };
      const podleDne = new Map<string, number>();
      const podleTechnika = new Map<string, number>();
      const soubory = new Set<string>();

      for (const d of zpravySnap.docs) {
        const data = d.data();
        const nahrano = data.nahrano instanceof Timestamp ? data.nahrano.toDate() : null;
        if (!nahrano) continue;
        const den = denPraha(nahrano);
        if (den.slice(0, 7) !== mesicParam) continue;

        celkem += 1;
        podleDne.set(den, (podleDne.get(den) ?? 0) + 1);
        if (typeof data.soubor_nazev === "string") soubory.add(data.soubor_nazev);
        if (data.cteno_claude === true) ctenoClaude += 1;

        const vysledek = data.vysledek_revize;
        if (vysledek === "OK" || vysledek === "NOK" || vysledek === "KE_KONTROLE") vysledky[vysledek] += 1;
        else vysledky.nezname += 1;

        const technik = typeof data.technik_jmeno === "string" && data.technik_jmeno ? data.technik_jmeno : "(neznámý)";
        podleTechnika.set(technik, (podleTechnika.get(technik) ?? 0) + 1);

        if (data.ignorovano === true) {
          ignorovano += 1;
          continue;
        }
        const cislo = typeof data.cislo_zarizeni === "string" ? data.cislo_zarizeni : "";
        if (!cislo) {
          chybiCislo += 1;
          continue;
        }
        const druh = data.druh_revize;
        const frekvence = planyPodleZarizeni.get(cislo) ?? [];
        const odpovidajici = jeDruhRevize(druh) ? frekvence.filter((f) => planOdpovidaDruhu(f, druh)) : frekvence;
        if (odpovidajici.length === 1) prirazeno += 1;
        else if (odpovidajici.length === 0) bezShody += 1;
        else viceShod += 1;
      }

      typy.push({
        typ: kolekce.typ,
        label: kolekce.label,
        celkem,
        prirazeno,
        bezShody,
        viceShod,
        ignorovano,
        chybiCislo,
        ctenoClaude,
        souboru: soubory.size,
        vysledky,
        podleDne: [...podleDne.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([den, pocet]) => ({ den, pocet })),
        technici: [...podleTechnika.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([jmeno, pocet]) => ({ jmeno, pocet })),
        celkemVDatabazi: celkemSnap.data().count,
      });
    }

    return NextResponse.json({ mesic: mesicParam, typy, cas: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Přehled se nepodařilo spočítat kvůli neznámé chybě na serveru." },
      { status: 500 }
    );
  }
}
