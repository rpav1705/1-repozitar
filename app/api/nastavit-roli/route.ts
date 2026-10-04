import { NextRequest, NextResponse } from "next/server";
import {
  ChybaKonfiguraceFirebase,
  ChybiOpravneniAdmin,
  overitAdmina,
  ziskejAdminFirestore,
} from "@/lib/firebaseAdmin";

// firebase-admin používá Node.js API (crypto, fs) – na Edge runtime neběží.
export const runtime = "nodejs";

/**
 * Změní roli existujícího uživatele v kolekci "uzivatele" (merge, ať se
 * nepřepíšou pole vytvoril/vytvoreno založená při vytvoreni-uzivatele) –
 * používá tabulka v Administraci, viz app/administrace/page.tsx. Jen pro
 * adminy a admin si touhle cestou nesmí sebrat vlastní roli (ať se omylem
 * nezamkne ven z Administrace), to appka hlídá i na klientovi, ale server
 * je jediné místo, které to musí hlídat spolehlivě.
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
      return NextResponse.json({ error: "Nemáš oprávnění měnit role." }, { status: 403 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Neplatný nebo chybějící přihlašovací token." },
      { status: 401 }
    );
  }

  let email: string;
  let role: "admin" | "uzivatel";
  try {
    const body = await request.json();
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    role = body.role === "admin" ? "admin" : body.role === "uzivatel" ? "uzivatel" : null!;
    if (!email || !role) {
      throw new Error("Chybí e-mail nebo role.");
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Neplatné tělo požadavku." },
      { status: 400 }
    );
  }

  if (email === adminEmail.toLowerCase()) {
    return NextResponse.json({ error: "Nemůžeš změnit vlastní roli." }, { status: 400 });
  }

  try {
    await ziskejAdminFirestore()
      .collection("uzivatele")
      .doc(email)
      .set({ role, email, upravilRoli: adminEmail, roleUpravenaAt: new Date().toISOString() }, { merge: true });

    return NextResponse.json({ email, role });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Změna role se nepodařila kvůli neznámé chybě na serveru.",
      },
      { status: 500 }
    );
  }
}
