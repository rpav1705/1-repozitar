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

type Role = "admin" | "uzivatel";

/**
 * Založí nový účet (Firebase Auth + dokument role v kolekci "uzivatele")
 * přes Admin SDK – na rozdíl od dřívějšího čistě klientského řešení
 * (createUserWithEmailAndPassword v prohlížeči adminovi) tohle nepřihlásí
 * nově založený účet místo admina, takže admin zůstává přihlášený a
 * nemusí se po založení znovu přihlašovat. Volající musí mít roli "admin" –
 * viz overitAdmina.
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
      return NextResponse.json({ error: "Nemáš oprávnění zakládat nové uživatele." }, { status: 403 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Neplatný nebo chybějící přihlašovací token." },
      { status: 401 }
    );
  }

  let email: string;
  let heslo: string;
  let role: Role;
  try {
    const body = await request.json();
    email = typeof body.email === "string" ? body.email.trim() : "";
    heslo = typeof body.heslo === "string" ? body.heslo : "";
    role = body.role === "admin" ? "admin" : "uzivatel";
    if (!email || !heslo) {
      throw new Error("Chybí e-mail nebo heslo.");
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Neplatné tělo požadavku." },
      { status: 400 }
    );
  }

  try {
    const noveUzivatel = await ziskejAdminAuth().createUser({ email, password: heslo });
    await ziskejAdminFirestore()
      .collection("uzivatele")
      .doc(email.toLowerCase())
      .set({ role, email: email.toLowerCase(), vytvoril: adminEmail, vytvoreno: new Date().toISOString() });

    return NextResponse.json({ uid: noveUzivatel.uid, email, role });
  } catch (err) {
    const zprava =
      err && typeof err === "object" && "code" in err && (err as { code: string }).code === "auth/email-already-exists"
        ? "Účet s tímto e-mailem už existuje."
        : err instanceof Error
          ? err.message
          : "Založení účtu se nepodařilo kvůli neznámé chybě na serveru.";
    return NextResponse.json({ error: zprava }, { status: 400 });
  }
}
