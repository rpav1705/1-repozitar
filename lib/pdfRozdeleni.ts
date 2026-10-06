/**
 * Vyřezání stránek z nahraného PDF do samostatného souboru. Nahraný export
 * často obsahuje stovky revizních zpráv (jedna na stránku, např. 207
 * stránek) – bez vyřezání by odkaz "Revizní zpráva" u zařízení otevřel celý
 * soubor se všemi cizími zprávami. Appka proto každé zprávě uloží vlastní
 * PDF jen s jejími stránkami.
 *
 * Běží VÝHRADNĚ v prohlížeči. Knihovnu pdf-lib appka načte až při prvním
 * použití z CDN jako pevně zvolenou verzi s kontrolou integrity (SRI) – není
 * součástí balíčků ani bundlu.
 */
const PDF_LIB_URL = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";
const PDF_LIB_SRI = "sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI";

type PdfLibDokument = {
  getPageCount(): number;
  copyPages(zdroj: PdfLibDokument, indexy: number[]): Promise<unknown[]>;
  addPage(stranka: unknown): unknown;
  save(): Promise<Uint8Array>;
};
type PdfLibGlobal = {
  PDFDocument: {
    load(data: ArrayBuffer, volby?: { ignoreEncryption?: boolean }): Promise<PdfLibDokument>;
    create(): Promise<PdfLibDokument>;
  };
};

let nacitaniKnihovny: Promise<PdfLibGlobal> | null = null;

function nactiPdfLib(): Promise<PdfLibGlobal> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Vyřezání stránek PDF je dostupné jen v prohlížeči."));
  }
  const okno = window as unknown as { PDFLib?: PdfLibGlobal };
  if (okno.PDFLib) return Promise.resolve(okno.PDFLib);

  if (!nacitaniKnihovny) {
    nacitaniKnihovny = new Promise<PdfLibGlobal>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PDF_LIB_URL;
      script.integrity = PDF_LIB_SRI;
      script.crossOrigin = "anonymous";
      script.async = true;
      script.onload = () => {
        if (okno.PDFLib) resolve(okno.PDFLib);
        else reject(new Error("Knihovna pro dělení PDF se načetla, ale není dostupná."));
      };
      script.onerror = () => {
        nacitaniKnihovny = null;
        reject(new Error("Nepodařilo se načíst knihovnu pro dělení PDF (cdn.jsdelivr.net)."));
      };
      document.head.appendChild(script);
    });
  }
  return nacitaniKnihovny;
}

export type ZdrojPdf = {
  /** Kolik stránek má celý nahraný soubor. */
  pocetStran: number;
  /** Nové PDF jen se zadanými stránkami (1-based, v daném pořadí). */
  vyrez(strany: number[]): Promise<Uint8Array>;
};

/** Otevře nahraný PDF pro opakované vyřezávání (soubor se parsuje jen jednou). */
export async function otevriZdrojPdf(buffer: ArrayBuffer): Promise<ZdrojPdf> {
  const knihovna = await nactiPdfLib();
  // load() si data nechá – předaná kopie, ať volající buffer zůstane použitelný.
  const zdroj = await knihovna.PDFDocument.load(buffer.slice(0), { ignoreEncryption: true });
  return {
    pocetStran: zdroj.getPageCount(),
    async vyrez(strany) {
      const novy = await knihovna.PDFDocument.create();
      const kopie = await novy.copyPages(
        zdroj,
        strany.map((s) => s - 1)
      );
      kopie.forEach((s) => novy.addPage(s));
      return novy.save();
    },
  };
}
