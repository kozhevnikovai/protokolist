// Проба: где падает загрузка модели в Electron (код 132). Варианты: процесс обработчика Electron и режим Node.
import { app, utilityProcess } from "electron";
import { fork } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const W = join(here, "llm-probe-worker.mjs");
const run = (name, start) => new Promise(r => { const t0 = Date.now(); const p = start(); p.on("exit", (code, sig) => { console.log(`[probe] ${name}: выход ${code}${sig ? " " + sig : ""} через ${((Date.now() - t0) / 1000).toFixed(1)} с`); r(); }); });
app.whenReady().then(async () => {
  const env = (v, m) => ({ ...process.env, VARIANT: v, PROBE_MODEL: m });
  await run("utility 4b", () => utilityProcess.fork(W, [], { env: env("default", "4b"), stdio: "inherit" }));
  await run("utility 14b", () => utilityProcess.fork(W, [], { env: env("default", "14b"), stdio: "inherit" }));
  app.quit();
});
