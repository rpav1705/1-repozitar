import { NextRequest, NextResponse } from "next/server";
import { overitIdToken, ziskejAdminFirestore } from "@/lib/firebaseAdmin";
import {
  analyzujNesparovaneZpravy,
  PlanovanaRevizeRadek,
  RevizniZpravaRadek,
} from "@/lib/analyzaNesparovanychZprav";

// Vždycky se počítá znovu na vyžádání (tlačítko v appce), nikdy se
// neprerenderuje staticky při buildu ani se necachuje mezi požadavky – jinak
// by appka ukazovala zastaralý výsledek z doby buildu/prvního volání.
export const dynamic = "force-dynamic";
// firebase-admin používá Node.js API (crypto, fs) – na Edge runtime neběží.
export const runtime = "nodejs";

/**
 * Server-side analýza nespárovaných revizních zpráv (viz
 * lib/analyzaNesparovanychZprav.ts) – porovnání "revizni_zpravy" vs.
 * "planovane_revize" nad TISÍCI záznamů appka záměrně nedělá v prohlížeči
 * (dřív to dokázalo kartu zaseknout, viz podobné poznámky u
 * scripts/reprocess-all-revizni-zpravy.ts), ale tady, na serveru – appka jen
 * zavolá tenhle endpoint a zobrazí hotový výsledek.
 */
export async function GET(request: NextRequest) {
  // Endpoint sám o sobě není chráněný Firestore security rules (na rozdíl od
  // dotazů z prohlížeče) – appka proto musí ověřit přihlášení appky sama,
  // jinak by tenhle Route Handler mohl číslo zařízení a názvy souborů
  // revizních zpráv vydat komukoli, kdo zná URL. Zvlášť od výpočtu samotného,
  // ať appka umí rozlišit "nepřihlášen" (401) od skutečné chyby výpočtu (500).
  try {
    await overitIdToken(request.headers.get("authorization"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Neplatný nebo chybějící přihlašovací token." },
      { status: 401 }
    );
  }

  try {
    const db = ziskejAdminFirestore();

    const [zpravySnap, planySnap] = await Promise.all([
      db.collection("revizni_zpravy").select("cislo_zarizeni", "soubor_nazev", "stranka").get(),
      db.collection("planovane_revize").select("cislo_zarizeni", "pu").get(),
    ]);

    const zpravy: RevizniZpravaRadek[] = zpravySnap.docs.map((d) => {
      const data = d.data();
      return {
        cislo_zarizeni: typeof data.cislo_zarizeni === "string" ? data.cislo_zarizeni : "",
        soubor_nazev: typeof data.soubor_nazev === "string" ? data.soubor_nazev : "",
        stranka: typeof data.stranka === "number" ? data.stranka : 0,
      };
    });

    const plany: PlanovanaRevizeRadek[] = planySnap.docs.map((d) => {
      const data = d.data();
      return {
        cislo_zarizeni: typeof data.cislo_zarizeni === "string" ? data.cislo_zarizeni : "",
        pu: typeof data.pu === "string" ? data.pu : "",
      };
    });

    const vysledek = analyzujNesparovaneZpravy(zpravy, plany);

    return NextResponse.json({ ...vysledek, cas: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Analýzu se nepodařilo spustit kvůli neznámé chybě na serveru.",
      },
      { status: 500 }
    );
  }
}
