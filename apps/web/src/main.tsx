import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { BackendProvider, startLocal, startProxy } from "./lib/backend.tsx";
import "./styles.css";

async function start() {
  if (!import.meta.env.DEV) {
    const response = await fetch("/runtime-config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Comms environment configuration is unavailable");
    window.commsConfig = await response.json();
    document.title = `Comms — ${window.commsConfig!.environment}`;
  }
  // Local mode: the local comms service serves this page and its data; there's no Convex URL.
  // Proxy mode: the released web service forwards calls to Convex and holds the admin token itself.
  if (window.commsConfig?.mode === "local") startLocal();
  else if (window.commsConfig?.mode === "proxy") startProxy();
  const served = window.commsConfig?.mode === "local" || window.commsConfig?.mode === "proxy";
  const url = served ? undefined : (window.commsConfig?.convexUrl ?? import.meta.env.VITE_CONVEX_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:3240" : undefined));
  if (!served && !url) throw new Error("This deployment has no Convex URL");

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BackendProvider {...(url ? { convexUrl: url } : {})}>
        <App />
      </BackendProvider>
    </StrictMode>,
  );
}
start().catch((error: Error) => { document.getElementById("root")!.textContent = error.message; });
