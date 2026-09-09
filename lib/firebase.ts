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
// maxOperationRetryTime 2 minuty. Původně jsme ho kvůli podezření na
// chybějící CORS nastavení bucketu zkrátili na 20 s (viz cors.json) – ruční
// ověření (curl OPTIONS/GET přímo na firebasestorage.googleapis.com, i s
// Origin hlavičkou z appky) ale ukázalo, že tenhle endpoint vždycky vrací
// "Access-Control-Allow-Origin: *", takže CORS nikdy nebyl (a není) skutečná
// příčina "storage/retry-limit-exceeded" chyb – ty byly jen SDK vzdávající
// to moc brzo u přechodných síťových/rate-limit problémů (viz i souběžnost
// stahování v app/nahrat/page.tsx). 60 s dává víc prostoru na opakované
// pokusy, než appka operaci vzdá – a díky tlačítku "Přerušit zpracování"
// (a checkpointu, který umí pokračovat) už appka nemusí kvůli dlouhému
// čekání vypadat jako mrtvá/zaseklá tak jako dřív.
storage.maxOperationRetryTime = 60_000;