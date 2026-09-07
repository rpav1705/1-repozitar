"use client";

import { useState } from "react";
import { useAuth } from "@/lib/useAuth";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import { User } from "firebase/auth";

export function AuthGate({
  children,
}: {
  children: (user: User) => React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

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

          <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-8 py-8">
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
              <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
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

  return <>{children(user)}</>;
}
