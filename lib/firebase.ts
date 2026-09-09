// Import the functions you need from the SDKs you need
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyC7V3R_F80CrYA6in3QTpBrU4rArt6hWHw",
  authDomain: "repozitar-7f22a.firebaseapp.com",
  projectId: "repozitar-7f22a",
  storageBucket: "repozitar-7f22a.firebasestorage.app",
  messagingSenderId: "222082710521",
  appId: "1:222082710521:web:7f9878cabda74f9981b28"
};

// Initialize Firebase (jen jednou, i při hot-reloadu v Next.js)
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// Export services, které budeme používat v appce
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);

// Firebase Storage má u čtecích operací (getBytes/getBlob) defaultní
// maxOperationRetryTime 2 minuty – když selhávají kvůli chybějícímu CORS
// nastavení bucketu (viz cors.json v rootu repozitáře), SDK to celé 2
// minuty tiše zkouší znovu, než operaci zahodí jako chybu. Appka pak
// desítky/stovky souborů za sebou vypadá jako úplně zaseklá, i když ve
// skutečnosti jen čeká na vypršení každého jednoho pokusu. Zkrácením na 20 s
// se chyba (typicky CORS, ne pomalá síť – PDF soubory jsou malé) projeví
// rychle místo toho, aby appka vypadala jako mrtvá.
storage.maxOperationRetryTime = 20_000;