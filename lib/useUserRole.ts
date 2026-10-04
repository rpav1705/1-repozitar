"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { User } from "firebase/auth";
import { db } from "@/lib/firebase";

export type Role = "admin" | "uzivatel";

const UZIVATELE_COLLECTION = "uzivatele";

/**
 * Role se čte z Firestore kolekce "uzivatele" (dokument klíčovaný e-mailem
 * uživatele, viz app/api/vytvorit-uzivatele/route.ts). Chybějící dokument
 * (např. účty založené ještě před zavedením rolí) se bere jako "uzivatel" –
 * bezpečnější výchozí stav než omylem někoho udělat adminem.
 */
export function useUserRole(user: User | null) {
  const [role, setRole] = useState<Role>("uzivatel");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.email) {
      setRole("uzivatel");
      setLoading(false);
      return;
    }
    setLoading(true);
    const ref = doc(db, UZIVATELE_COLLECTION, user.email.toLowerCase());
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const data = snap.data();
        setRole(data?.role === "admin" ? "admin" : "uzivatel");
        setLoading(false);
      },
      () => {
        // Nejčastěji chybějící oprávnění ve Firestore security rules – bereme
        // to jako "uzivatel", ať appka spíš skryje administraci, než aby
        // spadla.
        setRole("uzivatel");
        setLoading(false);
      }
    );
    return () => unsubscribe();
  }, [user?.email]);

  return { role, loading };
}
