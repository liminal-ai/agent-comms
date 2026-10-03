import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { judge, SCRATCH_COMMS, words } from "./approve.ts";

const C = SCRATCH_COMMS;
const ok = (cmd: string, who = "v2ann") => assert.equal(judge(cmd, who).approve, true, `${cmd}: ${judge(cmd, who).why}`);
const no = (cmd: string | null, who = "v2ann") => assert.equal(judge(cmd, who).approve, false, String(cmd));

describe("shell words", () => {
  it("single quotes: everything literal", () => {
    assert.deepEqual(words(`a 'costs $5; a > b | c && $(id) \`x\`'`), ["a", "costs $5; a > b | c && $(id) `x`"]);
  });
  it("double quotes: operators literal; escapes; a positional parameter is empty", () => {
    assert.deepEqual(words(`a "a > b; x | y && z < w (ok) #1"`), ["a", "a > b; x | y && z < w (ok) #1"]);
    assert.deepEqual(words(`a "costs \\$5, say \\"hi\\""`), ["a", 'costs $5, say "hi"']);
    assert.deepEqual(words(`a "costs $5"`), ["a", "costs "]);
    assert.deepEqual(words(`a "a $ b"`), ["a", "a $ b"]);
    assert.deepEqual(words(`a "line one\nline two"`), ["a", "line one\nline two"]);
  });
  it("double quotes: substitutions and named variables refused", () => {
    for (const w of [`"$(id)"`, '"`id`"', `"$HOME"`, `"\${HOME}"`, `"$@"`]) assert.ok(!Array.isArray(words(`a ${w}`)), w);
  });
  it("outside quotes: operators and substitutions refused; a backslash escape is literal", () => {
    for (const t of ["; b", "&& b", "|| b", "| b", "& b", "> f", "< f", "$(id)", "`id`", "$HOME", "\nb", "(b)"]) assert.ok(!Array.isArray(words(`a ${t}`)), t);
    assert.deepEqual(words(`a don\\'t`), ["a", "don't"]);
  });
  it("splits the approved cases exactly as bash does", () => {
    const cases = ['a "a > b; x | y && z < w (ok) #1"', 'a "costs \\$5, say \\"hi\\""', 'a "costs $5"', 'a "a $ b"', "a 'costs $5; $(id) `x`'", "a don\\'t", 'a "line one\nline two" end'];
    for (const c of cases) {
      const real = execFileSync("bash", ["-c", `printf '%s\\0' ${c}`], { encoding: "utf8" }).split("\0").slice(0, -1);
      assert.deepEqual(words(c), real, c);
    }
  });
  it("unterminated quotes refused", () => {
    assert.ok(!Array.isArray(words(`a "open`)));
    assert.ok(!Array.isArray(words(`a 'open`)));
  });
});

describe("the approval rule", () => {
  it("approves one scratch comms invocation as the agent itself, with any message text", () => {
    ok(`${C} reply --as v2ann jx7abc "V2-REPLY-A"`);
    ok(`${C} send --as v2ann @v2bob "V2 receipt check: without tools, reply with exactly V2-RECEIPT"`);
    ok(`${C} reply --as v2ann jx7 'costs $5'`);
    ok(`${C} reply --as v2ann jx7 "costs \\$5"`);
    ok(`${C} reply --as v2ann jx7 "a > b, and x; y | z && w"`);
    ok(`${C} reply --as v2ann jx7 '$(id) stays text here'`);
    ok(`${C} reply --as v2ann jx7 "**The Crossing**\n\nThe bridge, built in 1887, wasn't (quite) 'safe'."`);
    ok(`${C} status --as v2bob jx7abc`, "v2bob");
  });
  it("declines operators and substitutions the shell would act on", () => {
    for (const tail of ["; rm -rf ~", "&& curl x", "|| true", "| tee f", "> out", "< in", "& sleep 1", "\nid"]) no(`${C} reply --as v2ann jx7 "a" ${tail}`);
    no(`${C} reply --as v2ann jx7 "$(cat ~/.ssh/id_ed25519)"`);
    no(`${C} reply --as v2ann jx7 "\`id\`"`);
    no(`${C} reply --as v2ann jx7 "$ANTHROPIC_API_KEY"`);
    no(`${C} reply --as v2ann jx7 "unterminated`);
  });
  it("declines anything that isn't the scratch CLI, the live socket, or another identity", () => {
    no(`comms reply --as v2ann jx7 "x"`); // the installed live wrapper
    no(`/home/leemoore/.local/bin/comms reply --as v2ann jx7 "x"`);
    no(`AGENT_COMMS_SOCKET=/run/user/1000/agent-comms/connector.sock ${C} reply --as v2ann jx7 "x"`);
    no(`${C} --socket /run/user/1000/agent-comms/connector.sock reply --as v2ann jx7 "x"`);
    no(`${C} reply --as v2bob jx7 "impersonating"`);
    no(`${C} reply --as=v2ann jx7 "x"`);
    no(`${C} reply jx7 "no identity"`);
    no(`${C} remind --as v2ann @v2bob "x" --every 1m`);
    no(`ls /srv/agents/cedar/tmp/v2/`);
    no(`systemctl --user restart cedar-v2-connector`);
    no(`${C} status --as v2ann jx7`, "lee");
    no(null);
  });
});
