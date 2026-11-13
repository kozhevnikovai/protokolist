// Съёмка настоящей работы приложения для README и роликов.
// Звук встречи подаётся как «звук компьютера»: getDisplayMedia подменяется потоком из файла (как звонок в Zoom).
import { _electron as electron, chromium } from "playwright-core";
import { readFileSync, readdirSync, mkdirSync, statSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const OUT = "media", RAW = "media/raw";
mkdirSync(RAW, { recursive: true });
const pcm = readFileSync(process.env.LIVE_PCM).toString("base64"); // s16le, 16 кГц, моно
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// 0. Первый запуск: выбор модели под компьютер (local-ai) и загрузка с прогрессом
{
  const fresh = await electron.launch({ args: ["--no-sandbox", "app/main.mjs"], env: { ...process.env, PROTOKOLIST_HOME: "/tmp/pk-fresh" }, recordVideo: { dir: RAW, size: { width: 1280, height: 800 } } });
  await fresh.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1280, 800); w.center(); });
  const w = await fresh.firstWindow(); await w.waitForSelector("#v-setup:not([hidden])", { timeout: 30e3 }); await w.waitForTimeout(1500);
  await w.screenshot({ path: join(OUT, "app-setup.png") }); log("снимок app-setup");
  await w.click("#dl"); await w.waitForTimeout(25e3);
  await w.screenshot({ path: join(OUT, "app-download.png") }); log("снимок app-download");
  const fv = w.video(); await fresh.close(); copyFileSync(await fv.path(), join(RAW, "setup.webm"));
}
const app = await electron.launch({ args: ["--no-sandbox", "app/main.mjs"], env: { ...process.env }, recordVideo: { dir: RAW, size: { width: 1280, height: 800 } } });
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.isVisible() || true); w.setSize(1280, 800); w.center(); });
await app.context().addInitScript(b64 => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const bin = atob(b64), n = bin.length >> 1, f = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); f[i] = (v > 32767 ? v - 65536 : v) / 32768; }
    const ctx = new AudioContext({ sampleRate: 16000 }), buf = ctx.createBuffer(1, n, 16000); buf.copyToChannel(f, 0);
    const src = ctx.createBufferSource(), dst = ctx.createMediaStreamDestination(); src.buffer = buf; src.connect(dst); src.start();
    window.__demoEnds = Date.now() + n / 16;
    return dst.stream;
  };
}, pcm);
const win = await app.firstWindow();
await win.reload(); await win.waitForTimeout(1500);
const shot = async name => { await win.waitForTimeout(400); await win.screenshot({ path: join(OUT, name + ".png") }); log("снимок", name); };
const nav = async v => { await win.click(`nav button[data-view="${v}"]`); await win.waitForTimeout(800); };
const marks = {}; const t0 = Date.now(); const mark = k => (marks[k] = (Date.now() - t0) / 1000);

// 1. Запись: живые субтитры и «Что я пропустил?»
await nav("record"); await shot("app-record");
await win.uncheck("#rec-mic"); mark("rec");
await win.click("#rec");
await win.waitForTimeout(75000); mark("live"); await shot("app-live");
await win.selectOption("#catch-min", "2"); await win.click("#catch-up"); mark("catch");
await win.waitForFunction(() => !document.querySelector("#catch").hidden && document.querySelector("#catch-stop").hidden && document.querySelector("#catch").textContent.trim().length > 40, null, { timeout: 15 * 60e3 });
mark("catch-done"); await shot("app-catch-up");
const left = await win.evaluate(() => window.__demoEnds - Date.now()); if (left > 0) await win.waitForTimeout(left + 1500);
await win.click("#rec"); mark("stop");
await win.waitForSelector("#v-result:not([hidden])", { timeout: 60 * 60e3 }); mark("result");
await shot("app-result");
// 2. Архив и вопрос к архиву
await nav("archive"); mark("archive"); await shot("app-archive");
await win.fill("#ask-q", process.env.ASK_Q || "Какие поручения дали и кому?"); await win.click("#ask-go"); mark("ask");
await win.waitForFunction(() => !document.querySelector("#ask-out").hidden && document.querySelector("#ask-stop").hidden, null, { timeout: 30 * 60e3 });
mark("ask-done"); await shot("app-ask");
// 3. Задачи из всех протоколов, подключения
await nav("tasks"); mark("tasks"); await shot("app-tasks");
await nav("settings"); mark("settings"); await shot("app-settings");
const v = win.video(); await app.close(); copyFileSync(await v.path(), join(RAW, "app.webm"));
writeFileSync(join(RAW, "marks.json"), JSON.stringify(marks, null, 1));
// 4. Протокол (HTML) первой встречи
const outDir = process.env.PROTOKOLIST_OUT, dirs = readdirSync(outDir).map(d => join(outDir, d)).filter(d => statSync(d).isDirectory()).sort();
const html = readdirSync(dirs[0]).find(f => f.endsWith(".html"));
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome" });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, recordVideo: { dir: RAW, size: { width: 1280, height: 800 } } });
await p.goto("file://" + join(dirs[0], html)); await p.waitForTimeout(800);
await p.screenshot({ path: join(OUT, "protocol.png") });
for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, 260); await p.waitForTimeout(500); }
const pv = p.video(); await p.close(); await b.close(); copyFileSync(await pv.path(), join(RAW, "protocol.webm"));
log("готово", marks);
