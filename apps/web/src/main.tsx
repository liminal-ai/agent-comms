import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

async function start() {
  if (!import.meta.env.DEV) {
    const response = await fetch("/runtime-config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Comms environment configuration is unavailable");
    window.commsConfig = await response.json();
    document.title = `Comms — ${window.commsConfig!.environment}`;
  }
  const url = window.commsConfig?.convexUrl ?? import.meta.env.VITE_CONVEX_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:3240" : undefined);
  if (!url) throw new Error("This deployment has no Convex URL");
  const convex = new ConvexReactClient(url);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    </StrictMode>,
  );
}
start().catch((error: Error) => { document.getElementById("root")!.textContent = error.message; });
