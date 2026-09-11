import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Revize · Repozitář",
  description: "Evidence revizí zařízení",
  // Zabrání Chromu/Google Translate nabízet/aplikovat automatický překlad
  // stránky – ten dokázal rozbít technické kódy a čísla zařízení v tabulkách
  // (zaměnil je za "přeložený" text, viz nahlášený problém s "REV-E-FRI01-1R").
  other: {
    google: "notranslate",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="cs"
      translate="no"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
