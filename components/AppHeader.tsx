"use client";

import { signOut, User } from "firebase/auth";
import { auth } from "@/lib/firebase";

export function AppHeader({ user }: { user: User }) {
  const handleLogout = async () => {
    await signOut(auth);
  };

  return (
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
  );
}
