#!/usr/bin/env node
import { run } from "./cli.ts";
import { writeOutput } from "./output.ts";
process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => writeOutput(process.stdout, text),
  stderr: (text) => process.stderr.write(text),
  input: process.stdin,
  readStdin: async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1_000_000) throw new Error("input too large");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  },
});
