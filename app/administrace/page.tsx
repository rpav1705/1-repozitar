"use client";

import { useState } from "react";
import { createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";
import { auth } from "@/lib/firebase";
import { nastavPrihlaseniZpravu } from "@/lib/prihlaseniZprava";

/**
 * Appka nemá vlastní backend ani role – přihlášení řeší čistě klientský
 * Firebase Auth SDK. Založení nového účtu přes createUserWithEmailAndPassword
 * proto (jak je u tohoto SDK obvyklé) rovnou přihlásí NOVĚ vytvořený účet
 * místo aktuálního – appka po založení proto sama zase odhlásí, ať se
 * administrátor nepřihlásí omylem natrvalo jako nový kolega, a na
 * přihlašovací obrazovce mu zobrazí zprávu, že se má přihlásit znovu
 * (viz lib/prihlaseniZprava.ts).
 */
function PridatUzivatele() {
  const [email, setEmail] = useState("");
  const [heslo, setHeslo] = useState("");
  const [hesloPotvrzeni, setHesloPotvrzeni] = useState("");
  const [error, setError] = useState("");
  const [odesilam, setOdesilam] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (heslo !== hesloPotvrzeni) {
      setError("Hesla se neshodují.");
      return;
    }

    const potvrzeno = window.confirm(
      `Založit nový účet pro ${email}?\n\nPo založení tě appka odhlásí – Firebase po registraci automaticky přihlásí nově vytvořený účet místo tebe. Budeš se muset přihlásit znovu vlastními údaji.`
    );
    if (!potvrzeno) return;

    setOdesilam(true);
    try {
      await createUserWithEmailAndPassword(auth, email, heslo);
      nastavPrihlaseniZpravu(`Účet pro ${email} byl úspěšně vytvořen. Přihlas se prosím znovu.`);
      await signOut(auth);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOdesilam(false);
    }
  };

  return (
    <div className="max-w-md rounded-lg bg-white p-6 shadow-sm">
      <h2 className="text-[15px] font-bold text-navy">Přidat uživatele</h2>
      <p className="mt-1 text-[12.5px] text-gray-500">
        Založí nový přihlašovací účet pro kolegu. Po odeslání formuláře tě appka
        odhlásí (Firebase po registraci automaticky přihlásí nově vytvořený
        účet) – budeš se muset znovu přihlásit vlastními údaji.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-gray-700">E-mail nového uživatele</label>
          <input
            type="email"
            placeholder="jmeno@firma.cz"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="rounded-md border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-gray-700">Heslo</label>
          <input
            type="password"
            placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
            value={heslo}
            onChange={(e) => setHeslo(e.target.value)}
            required
            minLength={6}
            className="rounded-md border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-gray-700">Heslo znovu</label>
          <input
            type="password"
            placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
            value={hesloPotvrzeni}
            onChange={(e) => setHesloPotvrzeni(e.target.value)}
            required
            minLength={6}
            className="rounded-md border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>

        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={odesilam}
          className="mt-1 rounded-md bg-accent py-2.5 text-sm font-bold tracking-wide text-white transition-colors hover:bg-orange-600 disabled:opacity-60"
        >
          {odesilam ? "ZAKLÁDÁM…" : "VYTVOŘIT ÚČET"}
        </button>
      </form>
    </div>
  );
}

export default function Administrace() {
  return (
    <AuthGate>
      {(user) => (
        <div className="flex min-h-full flex-1 flex-col bg-[#eef1f5]">
          <AppHeader user={user} />
          <AppNav />

          <div className="flex flex-col gap-4 px-7 py-6">
            <PridatUzivatele />
          </div>
        </div>
      )}
    </AuthGate>
  );
}
