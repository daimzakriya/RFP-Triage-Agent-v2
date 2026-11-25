"use client";

import dynamic from "next/dynamic";
import ErrorBoundary from "@/components/app/ErrorBoundary";

/* The workspace reads the Bid Desk and stored PDFs from this browser, so it renders on the client only. */
const App = dynamic(() => import("@/components/app/App"), { ssr: false, loading: () => <div className="h-full bg-bg" /> });

export default function Home() {
  return (
    <ErrorBoundary fallback={() => <Recover />}>
      <App />
    </ErrorBoundary>
  );
}

/* Last resort if the saved Bid Desk can't be loaded at all: let the person start fresh. */
function Recover() {
  return (
    <div className="h-full grid place-items-center p-8 text-center bg-bg text-ink">
      <div className="max-w-md">
        <h1 className="text-[19px] font-semibold">The workspace couldn&apos;t load</h1>
        <p className="mt-2 text-ink-2 text-[14px]">Reports saved in this browser by an earlier version couldn&apos;t be read. Clearing them fixes this. Your PDFs on disk are not affected.</p>
        <button
          className="mt-5 h-10 px-4 rounded-lg bg-hilite text-on-hilite font-semibold cursor-pointer"
          onClick={() => { try { localStorage.removeItem("rfp-triage-desk-v1"); } catch { /* storage blocked */ } location.hash = ""; location.reload(); }}
        >
          Clear saved reports and reload
        </button>
      </div>
    </div>
  );
}
