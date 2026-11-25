"use client";

import dynamic from "next/dynamic";

/* The workspace reads the Bid Desk and stored PDFs from this browser, so it renders on the client only. */
const App = dynamic(() => import("@/components/app/App"), { ssr: false, loading: () => <div className="h-full bg-bg" /> });

export default function Home() {
  return <App />;
}
