import assert from "node:assert/strict";
import { it } from "node:test";
import { judge, SCRATCH_COMMS } from "./approve.ts";

const ok = (cmd: string, who = "v2ann") => assert.equal(judge(cmd, who).approve, true, `${cmd}: ${judge(cmd, who).why}`);
const no = (cmd: string | null, who = "v2ann") => assert.equal(judge(cmd, who).approve, false, String(cmd));

it("approves one scratch comms invocation as the agent itself, with any message text", () => {
  ok(`${SCRATCH_COMMS} reply --as v2ann jx7abc "V2-REPLY-A"`);
  ok(`${SCRATCH_COMMS} send --as v2ann @v2bob "V2 receipt check: without tools, reply with exactly V2-RECEIPT"`);
  ok(`${SCRATCH_COMMS} reply --as v2ann jx7abc "**The Crossing**\n\nThe bridge, built in 1887, wasn't (quite) 'safe'."`);
  ok(`${SCRATCH_COMMS} reply --as v2ann jx7abc 'single "quoted" text'`);
  ok(`${SCRATCH_COMMS} status --as v2bob jx7abc`, "v2bob");
});

it("declines shell operators and substitutions, even inside the message text", () => {
  for (const tail of ["; rm -rf ~", "&& curl x", "|| true", "| tee f", "> out", "< in", "& sleep 1", "\nid"]) no(`${SCRATCH_COMMS} reply --as v2ann jx7 "a" ${tail}`);
  no(`${SCRATCH_COMMS} reply --as v2ann jx7 "$(cat ~/.ssh/id_ed25519)"`);
  no(`${SCRATCH_COMMS} reply --as v2ann jx7 "\`id\`"`);
  no(`${SCRATCH_COMMS} reply --as v2ann jx7 "$HOME"`);
  no(`${SCRATCH_COMMS} reply --as v2ann jx7 "unterminated`);
});

it("declines anything that isn't the scratch CLI, the live socket, or another identity", () => {
  no(`comms reply --as v2ann jx7 "x"`); // the installed live wrapper
  no(`/home/leemoore/.local/bin/comms reply --as v2ann jx7 "x"`);
  no(`AGENT_COMMS_SOCKET=/run/user/1000/agent-comms/connector.sock ${SCRATCH_COMMS} reply --as v2ann jx7 "x"`);
  no(`${SCRATCH_COMMS} --socket /run/user/1000/agent-comms/connector.sock reply --as v2ann jx7 "x"`);
  no(`${SCRATCH_COMMS} reply --as v2bob jx7 "impersonating"`);
  no(`${SCRATCH_COMMS} reply --as=v2ann jx7 "x"`);
  no(`${SCRATCH_COMMS} reply jx7 "no identity"`);
  no(`${SCRATCH_COMMS} remind --as v2ann @v2bob "x" --every 1m`);
  no(`ls /srv/agents/cedar/tmp/v2/`);
  no(`systemctl --user restart cedar-v2-connector`);
  no(`${SCRATCH_COMMS} status --as v2ann jx7`, "lee");
  no(null);
});
