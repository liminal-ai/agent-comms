import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createDirectClient } from "../src/direct.ts";

it("direct --config rejects a SQLite service config before credentials, network, or store startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaidot-mode-"));
  try {
    const dataDir = join(dir, "data-must-not-be-created");
    const configPath = join(dir, "service.json");
    const contents = JSON.stringify({ mode: "local", machine: "local", owner: "lee", dataDir });
    await writeFile(configPath, contents, { mode: 0o600 });
    await assert.rejects(createDirectClient({ participant: "dot", locator: "parent-dot", configPath }), /local-mode service config/);
    assert.equal(await readFile(configPath, "utf8"), contents);
    await assert.rejects(stat(dataDir), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
