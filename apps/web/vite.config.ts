import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => {
  // Dev only: `AGENT_COMMS_ADMIN_TOKEN_FILE=<file> vite` pre-fills the admin token
  // for a local session, so it never has to be typed or pasted. Never in a build.
  const tokenFile = command === "serve" ? process.env.AGENT_COMMS_ADMIN_TOKEN_FILE : undefined;
  const devToken = tokenFile ? readFileSync(tokenFile, "utf8").trim() : "";
  return {
    plugins: [react()],
    define: { __DEV_ADMIN_TOKEN__: JSON.stringify(devToken) },
    // The Convex API and the protocol live outside this app's folder.
    server: { port: 3790, host: "127.0.0.1", strictPort: true, fs: { allow: ["../.."] } },
    preview: { port: 3790, host: "127.0.0.1", strictPort: true },
  };
});
