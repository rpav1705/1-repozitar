"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  jeTypRevize,
  KolekceRevizi,
  kolekceProTyp,
  TypRevize,
  VYCHOZI_TYP_REVIZE,
} from "@/lib/typRevize";

const STORAGE_KEY = "typRevize";

type TypRevizeContextValue = {
  typ: TypRevize;
  /** Názvy kolekcí/složek aktuálně zvoleného druhu revizí (viz lib/typRevize.ts). */
  kolekce: KolekceRevizi;
  setTyp: (typ: TypRevize) => void;
};

const TypRevizeContext = createContext<TypRevizeContextValue | null>(null);

/**
 * Drží, který druh revizí (elektro, tlakové nádoby, …) má uživatel zrovna
 * zvolený – appka podle toho čte/zapisuje do příslušných kolekcí. Volba se
 * pamatuje v prohlížeči (localStorage), ať uživatel po obnovení stránky
 * neskončí zase na výchozím druhu. Potomky appka vykreslí až po načtení
 * uložené volby – jinak by stránky nejdřív stáhly data výchozího druhu a hned
 * je zahodily a stáhly znovu pro ten uložený.
 */
export function TypRevizeProvider({ children }: { children: React.ReactNode }) {
  const [typ, setTypState] = useState<TypRevize>(VYCHOZI_TYP_REVIZE);
  const [nacteno, setNacteno] = useState(false);

  useEffect(() => {
    try {
      const ulozeny = window.localStorage.getItem(STORAGE_KEY);
      if (jeTypRevize(ulozeny)) setTypState(ulozeny);
    } catch {
      // localStorage nemusí být dostupný (soukromý režim apod.) – zůstane výchozí druh.
    }
    setNacteno(true);
  }, []);

  const setTyp = useCallback((novy: TypRevize) => {
    setTypState(novy);
    try {
      window.localStorage.setItem(STORAGE_KEY, novy);
    } catch {
      // Volba platí aspoň do zavření karty, jen se nezapamatuje.
    }
  }, []);

  const value = useMemo<TypRevizeContextValue>(
    () => ({ typ, kolekce: kolekceProTyp(typ), setTyp }),
    [typ, setTyp]
  );

  if (!nacteno) return null;

  return <TypRevizeContext.Provider value={value}>{children}</TypRevizeContext.Provider>;
}

export function useTypRevize(): TypRevizeContextValue {
  const ctx = useContext(TypRevizeContext);
  if (!ctx) {
    throw new Error("useTypRevize se smí volat jen uvnitř TypRevizeProvider (viz app/layout.tsx).");
  }
  return ctx;
}
