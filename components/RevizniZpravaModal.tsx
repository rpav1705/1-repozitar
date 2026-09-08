"use client";

import { useEffect, useState } from "react";
import { doc, getDoc, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

type RevizniZpravaDetail = {
  datumProvedeni: Date | null;
  technikJmeno: string | null;
  technikCisloOpravneni: string | null;
  celkoveHodnoceni: string;
};

function useRevizniZpravaDetail(zpravaId: string) {
  const [detail, setDetail] = useState<RevizniZpravaDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const snap = await getDoc(doc(db, "revizni_zpravy", zpravaId));
        if (cancelled) return;
        if (!snap.exists()) {
          setError("Revizní zpráva nebyla nalezena.");
          return;
        }
        const data = snap.data();
        setDetail({
          datumProvedeni: data.datum_provedeni instanceof Timestamp ? data.datum_provedeni.toDate() : null,
          technikJmeno: typeof data.technik_jmeno === "string" ? data.technik_jmeno : null,
          technikCisloOpravneni:
            typeof data.technik_cislo_opravneni === "string" ? data.technik_cislo_opravneni : null,
          celkoveHodnoceni: typeof data.celkove_hodnoceni === "string" ? data.celkove_hodnoceni : "",
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Nepodařilo se načíst detail revizní zprávy.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [zpravaId]);

  return { detail, error, loading };
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">{label}</span>
      <span className="text-[13.5px] text-navy">{value || "—"}</span>
    </div>
  );
}

export function RevizniZpravaModal({
  zpravaId,
  pdfUrl,
  onClose,
}: {
  zpravaId: string;
  pdfUrl: string;
  onClose: () => void;
}) {
  const { detail, error, loading } = useRevizniZpravaDetail(zpravaId);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between bg-navy px-[18px] py-2.5 text-[13px] font-bold text-white">
          <span>Revizní zpráva</span>
          <button
            onClick={onClose}
            aria-label="Zavřít"
            className="text-white/70 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="px-[18px] py-4">
          {loading && <p className="text-[13px] text-gray-400">Načítám…</p>}

          {!loading && error && <p className="text-[13px] text-red-600">{error}</p>}

          {!loading && !error && detail && (
            <div className="divide-y divide-gray-100">
              <DetailRow
                label="Datum provedení"
                value={detail.datumProvedeni ? detail.datumProvedeni.toLocaleDateString("cs-CZ") : ""}
              />
              <DetailRow label="Provedl" value={detail.technikJmeno ?? ""} />
              <DetailRow label="Číslo oprávnění" value={detail.technikCisloOpravneni ?? ""} />
              <DetailRow label="Celkové hodnocení" value={detail.celkoveHodnoceni} />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-[18px] py-3">
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md bg-accent px-4 py-2 text-[12.5px] font-bold tracking-wide text-white transition-colors hover:bg-orange-600"
          >
            Otevřít PDF
          </a>
        </div>
      </div>
    </div>
  );
}
