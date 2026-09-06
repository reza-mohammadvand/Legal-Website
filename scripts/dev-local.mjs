import { spawn } from "node:child_process";
import { resolve } from "node:path";
const children = [
  spawn(process.execPath, ["server/local-api.mjs"], { stdio: "inherit" }),
  spawn(process.execPath, [resolve("node_modules/vinext/dist/cli.js"), "dev", "--port", "3010"], { stdio: "inherit" }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
for (const child of children) child.on("exit", (code) => {
  if (!stopping && code) stop(code);
});
