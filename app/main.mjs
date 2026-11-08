// Протоколист — настольное приложение (Electron). Главный процесс: окно, запись звука, фоновый обработчик.
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Notification, session, shell, utilityProcess } from "electron";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let win;
let worker;
const pending = new Map();
let seq = 0;

function startWorker() {
  worker = utilityProcess.fork(join(here, "worker.mjs"), [], { serviceName: "Протоколист: обработка", stdio: "inherit" });
  worker.on("message", m => {
    if (m.type === "progress" || m.type === "net") return win?.webContents.send(m.type, m);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
  worker.on("exit", () => { for (const p of pending.values()) p.reject(new Error("Обработчик завершился — попробуйте ещё раз")); pending.clear(); worker = null; });
}
function call(method, args) {
  if (!worker) startWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args }); });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 900, minHeight: 640, title: "Протоколист", backgroundColor: "#FFFFFF",
    icon: join(here, "ui", "icon.png"),
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(join(here, "ui", "index.html"));
  // ссылки из протоколов открываем в браузере, а не в окне приложения
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

// Звук встречи: системный «loopback» (Windows; macOS 14.2+ — через CoreAudio). Видео не пишем.
function grantLoopback() {
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ["screen"] }).then(s => cb({ video: s[0], audio: "loopback" })).catch(() => cb({}));
  });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(["media", "display-capture"].includes(perm)));
}

// Автостарт: Windows отмечает в реестре приложения, которые сейчас держат микрофон
const MEETING_APPS = [[/zoom/i, "Zoom"], [/telemost/i, "Яндекс Телемост"], [/ktalk|kontur/i, "Контур.Толк"], [/teams/i, "Microsoft Teams"], [/(yandex|browser)\.exe/i, "Яндекс Браузер"], [/chrome/i, "Google Chrome"], [/msedge/i, "Edge"], [/telegram/i, "Telegram"], [/skype/i, "Skype"], [/vk|sferum/i, "VK Звонки"]];
let lastNotified = "";
function watchMeetings() {
  if (process.platform !== "win32") return;
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged";
  setInterval(() => execFile("reg", ["query", key, "/s"], { windowsHide: true }, (err, out) => {
    if (err) return;
    const active = out.split(/\r?\n\r?\n/).filter(b => /LastUsedTimeStop\s+REG_QWORD\s+0x0\b/.test(b)).map(b => b.split(/\r?\n/).find(l => l.startsWith("HKEY")) ?? "");
    const hit = active.map(k => MEETING_APPS.find(([re]) => re.test(k.split("#").pop() ?? ""))).find(Boolean);
    const name = hit?.[1] ?? "";
    if (name && name !== lastNotified) {
      lastNotified = name;
      win?.webContents.send("meeting", { app: name });
      if (!win?.isFocused() && Notification.isSupported()) {
        const n = new Notification({ title: "Протоколист", body: `Похоже, началась встреча в ${name}. Записать?` });
        n.on("click", () => { win?.show(); win?.webContents.send("meeting", { app: name, start: true }); });
        n.show();
      }
    }
    if (!name) lastNotified = "";
  }), 10_000);
}

ipcMain.handle("core", (_e, method, args) => call(method, args));
ipcMain.handle("pick-file", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Аудио и видео", extensions: ["wav", "mp3", "m4a", "ogg", "oga", "opus", "webm", "mp4", "mkv", "mov", "aac", "flac", "wma"] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("pick-dir", async () => { const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle("save-recording", (_e, name, bytes) => {
  const dir = join(tmpdir(), "protokolist-rec");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, Buffer.from(bytes));
  return p;
});
ipcMain.handle("open", (_e, p) => shell.openPath(p));
ipcMain.handle("open-url", (_e, u) => shell.openExternal(u));
ipcMain.handle("platform", () => process.platform);

app.whenReady().then(() => { grantLoopback(); createWindow(); watchMeetings(); if (process.env.PROTOKOLIST_SMOKE) smoke(process.env.PROTOKOLIST_SMOKE); });

// Самопроверка собранного приложения (CI): обработчик, модели, распознавание файла, скриншот окна
async function smoke(file) {
  const fail = e => { console.error("SMOKE FAIL", e?.message ?? e); app.exit(1); };
  setTimeout(() => fail("таймаут"), 600_000);
  try {
    await new Promise(r => win.webContents.once("did-finish-load", r));
    const st = await call("status", {});
    if (st.missing.length) await call("download", {});
    const tr = await call("transcribe", { file });
    const r = await call("protocol", { transcript: tr, file, noProtocol: true });
    const png = await win.webContents.capturePage();
    writeFileSync(join(process.env.PROTOKOLIST_SMOKE_OUT ?? tmpdir(), "smoke.png"), png.toPNG());
    console.log("SMOKE OK", JSON.stringify({ version: st.version, speakers: tr.speakers.length, segments: tr.segments.length, files: r.files.length, net: r.netBytes }));
    app.exit(0);
  } catch (e) { fail(e); }
}
app.on("window-all-closed", () => { worker?.kill(); app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
