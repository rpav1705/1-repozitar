"use client";

import { useState, useEffect } from "react";
import { auth } from "@/lib/firebase";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  User,
} from "firebase/auth";

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  if (loading) {
    return (
      <main style={{ padding: 40, fontFamily: "sans-serif" }}>
        <p>Načítání...</p>
      </main>
    );
  }

  if (user) {
    return (
      <main style={{ padding: 40, fontFamily: "sans-serif" }}>
        <h1>Vítej, {user.email}!</h1>
        <p>Jsi úspěšně přihlášený.</p>
        <button onClick={handleLogout} style={{ padding: "8px 16px", marginTop: 16 }}>
          Odhlásit se
        </button>
      </main>
    );
  }

  return (
    <main style={{ padding: 40, fontFamily: "sans-serif", maxWidth: 400 }}>
      <h1>{isLogin ? "Přihlášení" : "Registrace"}</h1>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input
          type="email"
          placeholder="E-mail"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: 8 }}
        />
        <input
          type="password"
          placeholder="Heslo"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{ padding: 8 }}
        />
        {error && <p style={{ color: "red" }}>{error}</p>}
        <button type="submit" style={{ padding: 10 }}>
          {isLogin ? "Přihlásit se" : "Zaregistrovat se"}
        </button>
      </form>
      <button
        onClick={() => setIsLogin(!isLogin)}
        style={{ marginTop: 16, background: "none", border: "none", color: "blue", cursor: "pointer" }}
      >
        {isLogin ? "Nemáš účet? Zaregistruj se" : "Máš už účet? Přihlas se"}
      </button>
    </main>
  );
}