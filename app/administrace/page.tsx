"use client";

import { useEffect, useState } from "react";
import { User } from "firebase/auth";
import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";
import { useUserRole, Role } from "@/lib/useUserRole";

type RadekUzivatele = {
  uid: string;
  email: string;
  role: Role;
  vytvoreno: string;
  posledniPrihlaseni: string | null;
};

const ROLE_LABELY: Record<Role, string> = { admin: "Admin", uzivatel: "Uživatel" };

function formatDatum(iso: string | null): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short" });
}

function SeznamUzivatelu({ adminUser, reloadKey }: { adminUser: User; reloadKey: number }) {
  const [radky, setRadky] = useState<RadekUzivatele[] | null>(null);
  const [error, setError] = useState("");
  const [ukladaSeEmail, setUkladaSeEmail] = useState<string | null>(null);

  const zmenRoli = async (email: string, novaRole: Role) => {
    setError("");
    setUkladaSeEmail(email);
    const predchozi = radky;
    setRadky((r) => r?.map((u) => (u.email === email ? { ...u, role: novaRole } : u)) ?? r);
    try {
      const token = await adminUser.getIdToken();
      const res = await fetch("/api/nastavit-roli", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, role: novaRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Změna role se nepodařila.");
    } catch (err) {
      setRadky(predchozi);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUkladaSeEmail(null);
    }
  };

  useEffect(() => {
    let zruseno = false;
    setError("");
    (async () => {
      try {
        const token = await adminUser.getIdToken();
        const res = await fetch("/api/seznam-uzivatelu", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Načtení seznamu uživatelů se nepodařilo.");
        if (!zruseno) setRadky(data.uzivatele);
      } catch (err) {
        if (!zruseno) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      zruseno = true;
    };
  }, [adminUser, reloadKey]);

  return (
    <div className="max-w-2xl rounded-lg bg-white p-6 shadow-sm">
      <h2 className="text-[15px] font-bold text-navy">Uživatelé</h2>

      {error && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
      )}

      {!error && radky === null && (
        <p className="mt-3 text-sm text-gray-500">Načítání...</p>
      )}

      {radky && radky.length > 0 && (
        <table className="mt-4 w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-gray-200 text-gray-500">
              <th className="pb-2 font-semibold">E-mail</th>
              <th className="pb-2 font-semibold">Role</th>
              <th className="pb-2 font-semibold">Založen</th>
              <th className="pb-2 font-semibold">Poslední přihlášení</th>
            </tr>
          </thead>
          <tbody>
            {radky.map((u) => {
              const jeToJa = u.email.toLowerCase() === adminUser.email?.toLowerCase();
              return (
                <tr key={u.uid} className="border-b border-gray-100">
                  <td className="py-2 text-navy">{u.email}</td>
                  <td className="py-2">
                    <select
                      value={u.role}
                      disabled={jeToJa || ukladaSeEmail === u.email}
                      onChange={(e) => zmenRoli(u.email, e.target.value === "admin" ? "admin" : "uzivatel")}
                      title={jeToJa ? "Nemůžeš změnit vlastní roli" : undefined}
                      className={`rounded-full border-0 px-2 py-0.5 text-[11px] font-semibold outline-none disabled:cursor-not-allowed disabled:opacity-70 ${
                        u.role === "admin" ? "bg-orange-50 text-accent" : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      <option value="uzivatel">{ROLE_LABELY.uzivatel}</option>
                      <option value="admin">{ROLE_LABELY.admin}</option>
                    </select>
                  </td>
                  <td className="py-2 text-gray-500">{formatDatum(u.vytvoreno)}</td>
                  <td className="py-2 text-gray-500">{formatDatum(u.posledniPrihlaseni)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PridatUzivatele({
  adminUser,
  onVytvoreno,
}: {
  adminUser: User;
  onVytvoreno: () => void;
}) {
  const [email, setEmail] = useState("");
  const [heslo, setHeslo] = useState("");
  const [hesloPotvrzeni, setHesloPotvrzeni] = useState("");
  const [novaRole, setNovaRole] = useState<Role>("uzivatel");
  const [error, setError] = useState("");
  const [uspech, setUspech] = useState("");
  const [odesilam, setOdesilam] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setUspech("");

    if (heslo !== hesloPotvrzeni) {
      setError("Hesla se neshodují.");
      return;
    }

    setOdesilam(true);
    try {
      const token = await adminUser.getIdToken();
      const res = await fetch("/api/vytvorit-uzivatele", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email, heslo, role: novaRole }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Založení účtu se nepodařilo.");
      }
      setUspech(`Účet pro ${email} byl úspěšně založen (role: ${novaRole === "admin" ? "admin" : "uživatel"}).`);
      setEmail("");
      setHeslo("");
      setHesloPotvrzeni("");
      setNovaRole("uzivatel");
      onVytvoreno();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOdesilam(false);
    }
  };

  return (
    <div className="max-w-md rounded-lg bg-white p-6 shadow-sm">
      <h2 className="text-[15px] font-bold text-navy">Přidat uživatele</h2>
      <p className="mt-1 text-[12.5px] text-gray-500">
        Založí nový přihlašovací účet pro kolegu. Zůstaneš přihlášený/á jako admin.
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
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-gray-700">Role</label>
          <select
            value={novaRole}
            onChange={(e) => setNovaRole(e.target.value === "admin" ? "admin" : "uzivatel")}
            className="rounded-md border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          >
            <option value="uzivatel">Uživatel</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
        {uspech && <p className="rounded-md bg-green-50 px-3 py-2 text-xs text-green-700">{uspech}</p>}

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
      {(user) => <AdministraceObsah user={user} />}
    </AuthGate>
  );
}

function AdministraceObsah({ user }: { user: User }) {
  const { role, loading } = useUserRole(user);
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="flex min-h-full flex-1 flex-col bg-[#eef1f5]">
      <AppHeader user={user} role={role} />
      <AppNav role={role} />

      <div className="flex flex-col gap-4 px-7 py-6">
        {loading ? (
          <p className="text-sm text-gray-500">Načítání...</p>
        ) : role === "admin" ? (
          <>
            <SeznamUzivatelu adminUser={user} reloadKey={reloadKey} />
            <PridatUzivatele adminUser={user} onVytvoreno={() => setReloadKey((k) => k + 1)} />
          </>
        ) : (
          <div className="max-w-md rounded-lg bg-white p-6 shadow-sm">
            <p className="text-[13px] text-gray-600">Tahle sekce je jen pro adminy.</p>
          </div>
        )}
      </div>
    </div>
  );
}
