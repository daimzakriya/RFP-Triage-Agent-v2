import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./print.css";

export const metadata: Metadata = {
  title: "RFP Triage Agent · idiaz.io",
  description: "Drop in a government RFP and get an evidence-backed bid/no-bid report in about a minute.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#101114" },
    { media: "(prefers-color-scheme: light)", color: "#eef0f2" },
  ],
};

/* Applies the saved theme before first paint (dark unless the person chose light). */
const THEME = `try{if(localStorage.getItem("rfp-theme")!=="light")document.documentElement.classList.add("dark")}catch(e){document.documentElement.classList.add("dark")}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Geist for the interface; Instrument Sans and Bricolage Grotesque for the printed report */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Instrument+Sans:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
