import { App, cert, getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

/**
 * Server-only inicializace Firebase Admin SDK – NIKDY needovat z klientské
 * ("use client") komponenty. Admin SDK obchází Firestore security rules a
 * potřebuje service account klíč, který nesmí uniknout do JS bundlu appky.
 * Určeno výhradně pro Route Handlery v app/api/... (ty běží jen na serveru,
 * ne v prohlížeči) – appka na serveru tak zvládne spočítat i analýzu nad
 * tisíci záznamů, aniž by to zatížilo/zaseklo kartu v prohlížeči (viz
 * app/api/analyza-nesparovanych-zprav/route.ts).
 *
 * Přihlašovací údaje (v tomhle pořadí):
 *  1. Proměnná FIREBASE_SERVICE_ACCOUNT_JSON – celý obsah staženého service
 *     account JSON klíče (Firebase Console -> Project settings -> Service
 *     accounts -> Generate new private key) jako jeden řetězec. Tohle je
 *     cesta pro produkci na Vercelu (Project Settings -> Environment
 *     Variables) – tam appka nemá k dispozici soubor na disku.
 *  2. Jinak GOOGLE_APPLICATION_CREDENTIALS (cesta k souboru) přes
 *     applicationDefault() – stejná proměnná, jakou už appka používá lokálně
 *     pro scripts/reprocess-all-revizni-zpravy.ts (service-account-key.json
 *     v kořeni repa, viz .gitignore – nikdy se necommituje).
 */

/**
 * Chyba v konfiguraci Firebase Admin SDK na serveru (např. nevalidní nebo
 * chybějící FIREBASE_SERVICE_ACCOUNT_JSON) – odlišná od chyby přihlášení
 * uživatele, ať appka (viz app/api/.../route.ts) umí vrátit 500 "rozbitá
 * konfigurace", ne 401 "nejsi přihlášen/a".
 */
export class ChybaKonfiguraceFirebase extends Error {}

function ziskejPoverovaciUdaje() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) return applicationDefault();

  let parsovano: Record<string, unknown>;
  try {
    parsovano = JSON.parse(json);
  } catch (err) {
    // Nejčastější příčina: proměnná se na Vercelu vložila neúplná/ořezaná,
    // nebo private_key obsahuje neplatné escape znaky (např. skutečné zalomení
    // řádku místo "\n"). Skutečnou parse chybu logujeme na server (do Vercel
    // Logs), appce ale appka vrátí jen srozumitelnou hlášku – ne syrový JSON
    // parse error ani (natožpak) obsah klíče.
    console.error("FIREBASE_SERVICE_ACCOUNT_JSON: JSON.parse selhal.", err);
    throw new ChybaKonfiguraceFirebase(
      "Proměnná prostředí FIREBASE_SERVICE_ACCOUNT_JSON neobsahuje platný JSON " +
        "(zkontroluj na Vercelu, že se vložila celá a beze změny – zvlášť řádky " +
        "v private_key se znaky '\\n')."
    );
  }

  try {
    return cert(parsovano);
  } catch (err) {
    console.error("FIREBASE_SERVICE_ACCOUNT_JSON: cert() selhalo.", err);
    throw new ChybaKonfiguraceFirebase(
      "Proměnná prostředí FIREBASE_SERVICE_ACCOUNT_JSON je platný JSON, ale chybí v ní nebo je " +
        "neplatné některé z povinných polí service account klíče (project_id, client_email, " +
        "private_key)."
    );
  }
}

let app: App | null = null;

function ziskejAdminApp(): App {
  if (!app) {
    app = getApps()[0] ?? initializeApp({ credential: ziskejPoverovaciUdaje() });
  }
  return app;
}

export function ziskejAdminFirestore(): Firestore {
  return getFirestore(ziskejAdminApp());
}

/**
 * Ověří Firebase Auth ID token poslaný z appky (hlavička "Authorization:
 * Bearer <token>") – appka nikde jinde na serveru neběží, takže tohle je
 * jediné místo, které appce hlídá, že volající je opravdu přihlášený
 * uživatel appky (Route Handler sám o sobě, na rozdíl od Firestore
 * dotazů z prohlížeče, žádné security rules nevynucuje). Vrátí e-mail
 * uživatele při úspěchu, jinak vyhodí chybu.
 */
export async function overitIdToken(authorizationHeader: string | null): Promise<string> {
  const token = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : null;
  if (!token) {
    throw new Error("Chybí přihlašovací token (Authorization: Bearer <token>).");
  }
  const dekodovany = await getAuth(ziskejAdminApp()).verifyIdToken(token);
  return dekodovany.email ?? dekodovany.uid;
}
