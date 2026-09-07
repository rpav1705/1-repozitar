"use client";

import { useState, useEffect } from "react";
import { auth } from "@/lib/firebase";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  User,
} from "firebase/auth";

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-gradient-to-b from-navy to-navy-dark">
        <p className="text-sm text-white/70">Načítání...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-1 items-center justify-center bg-gradient-to-b from-navy to-navy-dark p-6">
        <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl">
          <div className="flex flex-col items-center gap-2 bg-navy px-8 py-7">
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#f2760f"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 7v5l3 2"></path>
            </svg>
            <div className="text-[17px] font-bold text-white">Revize &middot; Repozitář</div>
            <div className="text-xs text-white/60">Evidence revizí zařízení</div>
          </div>

          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-4 px-8 py-8"
          >
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-gray-700">E-mail</label>
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="rounded-md border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>

            {error && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
                {error}
              </p>
            )}

            <button
              type="submit"
              className="mt-1 rounded-md bg-accent py-2.5 text-sm font-bold tracking-wide text-white transition-colors hover:bg-orange-600"
            >
              {isLogin ? "PŘIHLÁSIT SE" : "ZAREGISTROVAT SE"}
            </button>

            <button
              type="button"
              onClick={() => setIsLogin(!isLogin)}
              className="mt-1 text-center text-xs text-gray-500 hover:text-navy"
            >
              {isLogin ? "Nemáš účet? Zaregistruj se" : "Máš už účet? Přihlas se"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const stats = [
    { label: "Aktivní revize", value: "0", note: "naplánováno · probíhá", color: "border-blue-600 text-blue-600" },
    { label: "Blíží se termín", value: "0", note: "do 14 dnů", color: "border-accent text-accent" },
    { label: "Po termínu", value: "0", note: "žádné záznamy", color: "border-status-overdue text-status-overdue" },
    { label: "Splněno včas", value: "—", note: "zatím žádná data", color: "border-status-ok text-status-ok" },
  ];

  return (
    <div className="flex min-h-full flex-1 flex-col bg-[#eef1f5]">
      <header className="flex flex-wrap items-center justify-between gap-3 bg-navy px-7 py-2.5 text-white">
        <div className="flex items-center gap-3.5">
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#f2760f"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9"></circle>
            <path d="M12 7v5l3 2"></path>
          </svg>
          <div>
            <div className="text-[15px] font-bold leading-tight">Revize &middot; Repozitář</div>
            <div className="text-[11px] text-white/60">Evidence revizí zařízení</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[13px] font-semibold leading-tight">{user.email}</div>
            <div className="text-[11px] text-white/60">Uživatel</div>
          </div>
          <button
            onClick={handleLogout}
            className="rounded-md bg-[#c0392b] px-4 py-1.5 text-[13px] font-semibold transition-colors hover:bg-[#a5311f]"
          >
            Odhlásit
          </button>
        </div>
      </header>

      <nav className="flex gap-1 border-b border-gray-200 bg-white px-7">
        <div className="border-b-[3px] border-accent px-4 py-3 text-[13px] font-semibold text-navy">
          Přehled revizí
        </div>
        <div className="cursor-default px-4 py-3 text-[13px] font-semibold text-gray-400">
          Nahrát dokumenty
        </div>
        <div className="cursor-default px-4 py-3 text-[13px] font-semibold text-gray-400">
          Administrace
        </div>
      </nav>

      <div className="flex flex-col gap-4 px-7 py-6">
        <div className="rounded-md border border-blue-100 bg-blue-50 px-4 py-2.5 text-[12.5px] text-blue-700">
          Vítej, {user.email}! Zatím tu nemáš žádné revize – jakmile nahrajeme plán a servisní
          protokoly, objeví se přehled tady.
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((s) => (
            <div
              key={s.label}
              className={`rounded-lg border-l-4 bg-white px-[18px] py-4 shadow-sm ${s.color.split(" ")[0]}`}
            >
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                {s.label}
              </div>
              <div className={`mt-1.5 text-[28px] font-bold ${s.color.split(" ")[1]}`}>
                {s.value}
              </div>
              <div className="mt-0.5 text-[11px] text-gray-400">{s.note}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            disabled
            className="cursor-not-allowed rounded-md bg-accent px-5 py-2.5 text-[13px] font-bold tracking-wide text-white opacity-60"
            title="Připravujeme"
          >
            + NAHRÁT REVIZI
          </button>
          <button
            disabled
            className="cursor-not-allowed rounded-md border border-gray-300 bg-white px-5 py-2.5 text-[13px] font-semibold text-navy opacity-60"
            title="Připravujeme"
          >
            Správa zařízení
          </button>
          <button
            disabled
            className="cursor-not-allowed rounded-md bg-blue-600 px-5 py-2.5 text-[13px] font-semibold text-white opacity-60"
            title="Připravujeme"
          >
            Import z Excelu
          </button>
        </div>

        <div className="overflow-hidden rounded-lg bg-white shadow-sm">
          <div className="flex items-center justify-between bg-navy px-[18px] py-2.5 text-[13px] font-bold text-white">
            <span>Přehled zařízení</span>
            <span className="text-[12px] font-normal text-white/60">0 záznamů</span>
          </div>
          <div className="px-[18px] py-10 text-center text-[13px] text-gray-400">
            Zatím žádná zařízení. Jakmile přidáme nahrávání .xls plánu a PDF protokolů, zobrazí se
            zde přehled revizí.
          </div>
        </div>
      </div>
    </div>
  );
}
