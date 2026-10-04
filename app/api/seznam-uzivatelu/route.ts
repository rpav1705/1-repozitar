import { NextRequest, NextResponse } from "next/server";
import {
  ChybaKonfiguraceFirebase,
  ChybiOpravneniAdmin,
  overitAdmina,
  ziskejAdminAuth,
  ziskejAdminFirestore,
} from "@/lib/firebaseAdmin";

// firebase-admin používá Node.js API (crypto, fs) – na Edge runtime neběží.
export const runtime = "nodejs";
// Appka má zobrazit aktuální seznam účtů, ne stránku prerenderovanou při buildu.
export const dynamic = "force-dynamic";

/**
 * Vypíše všechny účty Firebase Auth appky spolu s jejich rolí z kolekce
 * "uzivatele" – Admin SDK je jediný způsob, jak appka umí vyjmenovat
 * všechny existující účty (klientský SDK to neumí, Firestore drží jen roli,
 * ne seznam účtů samotných). Jen pro adminy, viz overitAdmina.
 */
export async function GET(request: NextRequest) {
  try {
    await overitAdmina(request.headers.get("authorization"));
  } catch (err) {
    if (err instanceof ChybaKonfiguraceFirebase) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    if (err instanceof ChybiOpravneniAdmin) {
      return NextResponse.json({ error: "Nemáš oprávnění vidět seznam uživatelů." }, { status: 403 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Neplatný nebo chybějící přihlašovací token." },
      { status: 401 }
    );
  }

  try {
    const adminAuth = ziskejAdminAuth();
    const uzivateleAuth: { uid: string; email: string; vytvoreno: string; posledniPrihlaseni: string | null }[] = [];
    let pageToken: string | undefined;
    do {
      const stranka = await adminAuth.listUsers(1000, pageToken);
      for (const u of stranka.users) {
        uzivateleAuth.push({
          uid: u.uid,
          email: u.email ?? "(bez e-mailu)",
          vytvoreno: u.metadata.creationTime,
          posledniPrihlaseni: u.metadata.lastSignInTime ?? null,
        });
      }
      pageToken = stranka.pageToken || undefined;
    } while (pageToken);

    const roleSnap = await ziskejAdminFirestore().collection("uzivatele").get();
    const role = new Map<string, string>();
    roleSnap.forEach((doc) => {
      const data = doc.data();
      role.set(doc.id, data.role === "admin" ? "admin" : "uzivatel");
    });

    const vysledek = uzivateleAuth
      .map((u) => ({
        ...u,
        role: role.get(u.email.toLowerCase()) ?? "uzivatel",
      }))
      .sort((a, b) => a.email.localeCompare(b.email));

    return NextResponse.json({ uzivatele: vysledek });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Načtení seznamu uživatelů se nepodařilo kvůli neznámé chybě na serveru.",
      },
      { status: 500 }
    );
  }
}
