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
function ziskejPoverovaciUdaje() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) return applicationDefault();
  try {
    return cert(JSON.parse(json));
  } catch {
    throw new Error(
      "Proměnná prostředí FIREBASE_SERVICE_ACCOUNT_JSON neobsahuje platný JSON service account klíče."
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
