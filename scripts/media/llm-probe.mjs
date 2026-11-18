// Проба: где падает загрузка модели в Electron (код 132). Варианты: процесс обработчика Electron и режим Node.
import { app, utilityProcess } from "electron";
import { fork } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const W = join(here, "llm-probe-worker.mjs");
const run = (name, start) => new Promise(r => { const t0 = Date.now(); const p = start(); p.on("exit", (code, sig) => { console.log(`[probe] ${name}: выход ${code}${sig ? " " + sig : ""} через ${((Date.now() - t0) / 1000).toFixed(1)} с`); r(); }); });
app.whenReady().then(async () => {
  const env = v => ({ ...process.env, VARIANT: v });
  await run("utility default", () => utilityProcess.fork(W, [], { env: env("default"), stdio: "inherit" }));
  await run("utility nommap", () => utilityProcess.fork(W, [], { env: env("nommap"), stdio: "inherit" }));
  await run("utility directio", () => utilityProcess.fork(W, [], { env: env("directio"), stdio: "inherit" }));
  await run("node-mode default", () => fork(W, [], { env: { ...env("default"), ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" }));
  app.quit();
});
