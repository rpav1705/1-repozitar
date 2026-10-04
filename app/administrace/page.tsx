"use client";

import { useState } from "react";
import { User } from "firebase/auth";
import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { AppNav } from "@/components/AppNav";
import { useUserRole, Role } from "@/lib/useUserRole";

function PridatUzivatele({ adminUser }: { adminUser: User }) {
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

  return (
    <div className="flex min-h-full flex-1 flex-col bg-[#eef1f5]">
      <AppHeader user={user} role={role} />
      <AppNav role={role} />

      <div className="flex flex-col gap-4 px-7 py-6">
        {loading ? (
          <p className="text-sm text-gray-500">Načítání...</p>
        ) : role === "admin" ? (
          <PridatUzivatele adminUser={user} />
        ) : (
          <div className="max-w-md rounded-lg bg-white p-6 shadow-sm">
            <p className="text-[13px] text-gray-600">Tahle sekce je jen pro adminy.</p>
          </div>
        )}
      </div>
    </div>
  );
}
