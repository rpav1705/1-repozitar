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

/**
 * Smaže účet (Firebase Auth + dokument role v kolekci "uzivatele") –
 * nevratné, appka si potvrzení vyžádá už na klientovi (window.confirm), viz
 * app/administrace/page.tsx. Jen pro adminy a admin si touhle cestou nesmí
 * smazat sám sebe (ať appka nezůstane bez jediného admina, který by směl
 * založit/opravit další účty).
 */
export async function POST(request: NextRequest) {
  let adminEmail: string;
  try {
    adminEmail = await overitAdmina(request.headers.get("authorization"));
  } catch (err) {
    if (err instanceof ChybaKonfiguraceFirebase) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    if (err instanceof ChybiOpravneniAdmin) {
      return NextResponse.json({ error: "Nemáš oprávnění mazat uživatele." }, { status: 403 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Neplatný nebo chybějící přihlašovací token." },
      { status: 401 }
    );
  }

  let uid: string;
  let email: string;
  try {
    const body = await request.json();
    uid = typeof body.uid === "string" ? body.uid : "";
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!uid || !email) {
      throw new Error("Chybí uid nebo e-mail uživatele.");
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Neplatné tělo požadavku." },
      { status: 400 }
    );
  }

  if (email === adminEmail.toLowerCase()) {
    return NextResponse.json({ error: "Nemůžeš smazat vlastní účet." }, { status: 400 });
  }

  try {
    await ziskejAdminAuth().deleteUser(uid);
    await ziskejAdminFirestore().collection("uzivatele").doc(email).delete();
    return NextResponse.json({ uid, email });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Smazání účtu se nepodařilo kvůli neznámé chybě na serveru.",
      },
      { status: 500 }
    );
  }
}
