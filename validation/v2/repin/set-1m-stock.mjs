// Settings on the stock lane (13976): new threads default to Claude (stock claudeAgent), Sonnet 5.5, 1M context window.
// Hazel's j-set-1m.mjs (/srv/work/t3code-v2-lhc/validation/v2-port/live/) with the two lane-specific values changed:
// it forces T3_TEST_LANE=lhc and selects the claude-lhc instance, which stock doesn't have.
delete process.env.T3_TEST_LANE;
const api = await import("/srv/work/t3code-v2-baseline/bin/rpc.mjs");
if (api.base !== "http://127.0.0.1:13976") throw new Error(`not the stock lane: ${api.base}`);
await api.rpc("server.updateSettings", {
  patch: {
    defaultModelSelection: {
      instanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
      options: [{ id: "contextWindow", value: "1m" }],
    },
  },
});
const s = await api.rpc("server.getSettings", {});
console.log(JSON.stringify({ lane: api.base, defaultModelSelection: s.defaultModelSelection ?? s.settings?.defaultModelSelection }));
api.ws.close();
