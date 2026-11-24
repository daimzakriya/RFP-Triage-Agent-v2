import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RFP Triage Agent · idiaz.io",
  description: "Drop in a government RFP and get an evidence-backed bid/no-bid report in about a minute.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
        />
        <meta name="theme-color" content="#0a0d14" />
      </head>
      <body>{children}</body>
    </html>
  );
}
