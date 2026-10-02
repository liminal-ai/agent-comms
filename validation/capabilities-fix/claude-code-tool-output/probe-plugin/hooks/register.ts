// Records every tool.call's result as the model reads it, for the fix-pass 0.1 check.
let n = 0;
export function register(on: any) {
  on("tool.call", async ($: any, e: any, next: any) => {
    const result = await next(e);
    const row = { at: new Date().toISOString(), tool: e.tool, toolUseId: e.tool_use_id, agentId: e.agentId ?? null, background: e.run_in_background === true, textLength: typeof result?.text === "string" ? result.text.length : null, text: result?.text ?? null };
    n += 1;
    await $.fs.write(`/home/leemoore/.local/state/hazel-proof-probe/${Date.now()}-${n}.json`, JSON.stringify(row));
    return result;
  });
}
