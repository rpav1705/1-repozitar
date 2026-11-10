"use client";

import { useEffect } from "react";

/**
 * Označení řádku tabulky kliknutím: klik na řádek ho označí (atribut
 * data-vybrano, vzhled viz app/globals.css) a zůstane označený, dokud
 * neklikneš znovu – na stejný řádek, mimo tabulku, nebo stiskneš Esc. Klik na
 * jiný řádek označení přesune. Klik na tlačítko/odkaz/pole uvnitř řádku
 * označení nikdy nezruší (jen řádek označí), ať se při úpravě buňky neztratí.
 * Označení drží přímo DOM (React atribut nezná, takže ho při překreslení
 * nepřepíše); při nahrazení řádku novými daty zmizí samo.
 */
const INTERAKTIVNI = "a, button, input, select, textarea, label, summary, [role='button']";

export default function VyberRadkuTabulky() {
  useEffect(() => {
    let vybrany: HTMLElement | null = null;

    const zrus = () => {
      vybrany?.removeAttribute("data-vybrano");
      vybrany = null;
    };

    const onClick = (e: MouseEvent) => {
      const cil = e.target instanceof Element ? e.target : null;
      const radek = cil?.closest("tbody tr") as HTMLElement | null;

      // Uživatel tažením označuje text ke zkopírování – nechat být.
      if (window.getSelection()?.toString()) return;

      if (!radek) {
        zrus();
        return;
      }
      const naPrvku = cil?.closest(INTERAKTIVNI) !== null;
      if (radek === vybrany) {
        if (!naPrvku) zrus();
        return;
      }
      zrus();
      radek.setAttribute("data-vybrano", "true");
      vybrany = radek;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") zrus();
    };

    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      zrus();
    };
  }, []);

  return null;
}
