// Проба: языковая модель в процессе обработчика Electron при разных размерах контекста (поиск падения с кодом 132)
import { app, utilityProcess } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const runs = (process.env.PROBE_CTX || "12288,8192,4096").split(",").map(Number);
app.whenReady().then(async () => {
  for (const ctx of runs) {
    const t0 = Date.now(); let last = "старт";
    const code = await new Promise(r => {
      const w = utilityProcess.fork(join(here, "llm-probe-worker.mjs"), [], { env: { ...process.env, PROBE_CTX: String(ctx) }, stdio: "inherit" });
      w.on("message", m => { last = m; console.log(`[probe ctx=${ctx}] ${((Date.now() - t0) / 1000).toFixed(1)} c: ${m}`); });
      w.on("exit", r);
    });
    console.log(`[probe ctx=${ctx}] выход ${code}, последний этап: ${last}`);
  }
  app.quit();
});
