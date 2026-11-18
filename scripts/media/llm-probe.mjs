// Проба: где падает загрузка модели в Electron (код 132). Варианты: процесс обработчика Electron и режим Node.
import { app, utilityProcess } from "electron";
import { fork } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const W = join(here, "llm-probe-worker.mjs");
let last = "—";
const run = (name, start) => new Promise(r => { const t0 = Date.now(); last = "—"; const p = start(); p.on?.("message", m => { last = String(m).slice(0, 120); }); p.on("exit", (code, sig) => { const msg = `${process.platform}-${process.arch} ${name}: выход ${code}${sig ? " " + sig : ""} через ${((Date.now() - t0) / 1000).toFixed(1)} с, последний этап: ${last}`; console.log(`[probe] ${msg}`); console.log(`::notice title=probe::${msg}`); r(); }); });
app.whenReady().then(async () => {
  const env = (v, m) => ({ ...process.env, VARIANT: v, PROBE_MODEL: m });
  await run("utility 4b", () => utilityProcess.fork(W, [], { env: env("default", "3-4b"), stdio: "inherit" }));
  if (!process.env.PROBE_ONLY_4B) await run("utility 14b", () => utilityProcess.fork(W, [], { env: env("default", "14b"), stdio: "inherit" }));
  app.quit();
});
