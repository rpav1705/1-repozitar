/**
 * OCR pro naskenované revizní zprávy (PDF bez textové vrstvy – pdf.js z nich
 * nepřečte žádný text). Běží VÝHRADNĚ v prohlížeči: stránku vykreslí do
 * canvasu a přečte ji Tesseract.js (WASM) s českým jazykovým modelem.
 *
 * Knihovnu appka načte až při prvním použití z CDN jako pevně zvolenou verzi
 * s kontrolou integrity (SRI) – není tedy součástí balíčků ani bundlu a
 * nezdržuje načtení appky ostatním. Samotný worker, jádro a český jazykový
 * model (cca 7 MB) si Tesseract.js stáhne při prvním OCR a pak je drží v
 * cache prohlížeče.
 */
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const TESSERACT_SRI = "sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F";

/** Šířka vykreslené stránky v pixelech – pro sken A4 zhruba 240 DPI, dost na OCR a ještě rozumně rychlé. */
const CILOVA_SIRKA_PX = 2000;

type TesseractWorker = {
  recognize(image: HTMLCanvasElement): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
};
type TesseractGlobal = {
  createWorker(langs: string): Promise<TesseractWorker>;
};

let nacitaniKnihovny: Promise<TesseractGlobal> | null = null;

function nactiTesseract(): Promise<TesseractGlobal> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("OCR je dostupné jen v prohlížeči."));
  }
  const okno = window as unknown as { Tesseract?: TesseractGlobal };
  if (okno.Tesseract) return Promise.resolve(okno.Tesseract);

  if (!nacitaniKnihovny) {
    nacitaniKnihovny = new Promise<TesseractGlobal>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = TESSERACT_URL;
      script.integrity = TESSERACT_SRI;
      script.crossOrigin = "anonymous";
      script.async = true;
      script.onload = () => {
        if (okno.Tesseract) resolve(okno.Tesseract);
        else reject(new Error("OCR knihovna se načetla, ale není dostupná."));
      };
      script.onerror = () => {
        nacitaniKnihovny = null;
        reject(
          new Error(
            "Nepodařilo se načíst OCR knihovnu (cdn.jsdelivr.net). Zkontroluj připojení k internetu a zkus to znovu."
          )
        );
      };
      document.head.appendChild(script);
    });
  }
  return nacitaniKnihovny;
}

export type OcrEngine = {
  /** Přečte text z vykresleného canvasu. */
  rozpoznej(canvas: HTMLCanvasElement): Promise<string>;
  /** Uvolní worker – volat vždy po dokončení práce (drží paměť i vlákno). */
  ukonci(): Promise<void>;
};

export async function vytvorOcr(): Promise<OcrEngine> {
  const tesseract = await nactiTesseract();
  const worker = await tesseract.createWorker("ces");
  return {
    rozpoznej: async (canvas) => (await worker.recognize(canvas)).data.text,
    ukonci: async () => {
      await worker.terminate();
    },
  };
}

type VykreslitelnaStranka = {
  getViewport(parametry: { scale: number }): { width: number; height: number };
  render(parametry: unknown): { promise: Promise<unknown> };
};

/** Vykreslí stránku PDF do canvasu a přečte z ní text; vrací neprázdné řádky. */
export async function ocrRadkyStranky(
  stranka: VykreslitelnaStranka,
  engine: OcrEngine
): Promise<string[]> {
  const zakladni = stranka.getViewport({ scale: 1 });
  const mereni = Math.min(4, Math.max(1.5, CILOVA_SIRKA_PX / zakladni.width));
  const viewport = stranka.getViewport({ scale: mereni });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Nepodařilo se vytvořit canvas pro OCR.");
  // Bílé pozadí – skeny/PDF bez pozadí by se jinak vykreslily průhledně (černě).
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // canvas i canvasContext – různé verze pdf.js vyžadují jedno nebo druhé.
  await stranka.render({ canvas, canvasContext: ctx, viewport }).promise;

  const text = await engine.rozpoznej(canvas);
  canvas.width = 0;
  canvas.height = 0;
  return text
    .split(/\r?\n/)
    .map((radek) => radek.trim())
    .filter(Boolean);
}
