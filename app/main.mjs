// Протоколист — настольное приложение (Electron). Главный процесс: окно, запись звука, фоновый обработчик.
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Notification, powerSaveBlocker, safeStorage, session, shell, utilityProcess } from "electron";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

// Одна копия приложения: вторая просто показывает первое окно (иначе две копии пишут в одни файлы)
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
// Windows: своя иконка и группировка в панели задач, а не иконка Electron
if (process.platform === "win32") app.setAppUserModelId("ai.kozhevnikov.protokolist");

// ── Ключи интеграций: шифруются средствами ОС (DPAPI / связка ключей), расшифровываются только в памяти
const SECRET_KEYS = ["bitrix24.webhook", "yougile.key", "telegram.token", "llm.apiKey"];
const getPath = (o, k) => k.split(".").reduce((a, x) => a?.[x], o);
const home = () => process.env.PROTOKOLIST_HOME || (process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Protokolist") : join(homedir(), ".protokolist"));
const cfgFile = () => join(home(), "config.json");
const raw = () => { try { return JSON.parse(readFileSync(cfgFile(), "utf8")); } catch { return {}; } };
const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
const enc = v => (v && canEncrypt() ? "enc:" + safeStorage.encryptString(v).toString("base64") : v);
function secrets() {
  const c = raw(), out = {};
  for (const k of SECRET_KEYS) {
    const v = getPath(c, k);
    if (typeof v === "string" && v.startsWith("enc:")) { try { out[k] = safeStorage.decryptString(Buffer.from(v.slice(4), "base64")); } catch { out[k] = ""; } }
  }
  return out;
}
/** Старые настройки с ключами открытым текстом — шифруем при первом запуске */
function migrateSecrets() {
  if (!existsSync(cfgFile()) || !canEncrypt()) return;
  const c = raw();
  let changed = false;
  for (const k of SECRET_KEYS) {
    const v = getPath(c, k);
    if (typeof v === "string" && v && !v.startsWith("enc:")) { const ks = k.split("."); c[ks[0]][ks[1]] = enc(v); changed = true; }
  }
  if (changed) writeFileSync(cfgFile(), JSON.stringify(c, null, 2));
}
/** В интерфейс ключи не отдаём: только «задан / не задан» */
function maskConfig(c) {
  const set = {};
  for (const k of SECRET_KEYS) { const ks = k.split("."); set[k] = !!c?.[ks[0]]?.[ks[1]]; if (c?.[ks[0]]?.[ks[1]]) c[ks[0]][ks[1]] = ""; }
  return { ...c, secretsSet: set };
}
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
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args, secrets: secrets() }); });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 900, minHeight: 640, title: "Протоколист", backgroundColor: "#FFFFFF",
    icon: join(here, "ui", "icon.png"),
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  // закрытие во время записи или обработки — только с подтверждением
  win.on("close", e => {
    if (!appState.recording && !appState.busy) return;
    const r = dialog.showMessageBoxSync(win, { type: "warning", buttons: ["Не закрывать", "Закрыть"], defaultId: 0, cancelId: 0, title: "Протоколист", message: appState.recording ? "Идёт запись встречи" : "Идёт обработка встречи", detail: appState.recording ? "Записанное уже сохранено на диск — при следующем запуске его можно будет восстановить. Всё равно закрыть?" : "Обработка прервётся. Запись останется, её можно обработать заново. Всё равно закрыть?" });
    if (r === 0) e.preventDefault();
  });
  win.loadFile(join(here, "ui", "index.html"));
  // ссылки из протоколов открываем в браузере, а не в окне приложения
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

// Звук встречи: системный «loopback» (Windows; macOS 14.2+ — через CoreAudio). Видео не пишем.
function grantLoopback() {
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ["screen"] }).then(s => cb({ video: s[0], audio: "loopback" })).catch(() => cb({}));
  });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(["media", "display-capture", "notifications"].includes(perm)));
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

let appState = { recording: false, busy: false };
let sleepBlock = null;
ipcMain.handle("state", (_e, st) => {
  appState = { ...appState, ...st };
  // во время записи не даём системе уснуть — иначе звук обрывается
  if (appState.recording && sleepBlock === null) sleepBlock = powerSaveBlocker.start("prevent-app-suspension");
  if (!appState.recording && sleepBlock !== null) { powerSaveBlocker.stop(sleepBlock); sleepBlock = null; }
});

ipcMain.handle("core", async (_e, method, args) => {
  if (method === "saveConfig") {
    const patch = structuredClone(args?.patch ?? {});
    for (const k of SECRET_KEYS) {
      const ks = k.split("."), v = patch?.[ks[0]]?.[ks[1]];
      if (v === undefined) continue;
      if (v === "") delete patch[ks[0]][ks[1]]; // пустое поле — ключ не меняем
      else if (v === "\u0000clear") patch[ks[0]][ks[1]] = ""; // кнопка «Отключить»
      else patch[ks[0]][ks[1]] = enc(v);
    }
    return maskConfig(await call("saveConfig", { patch }));
  }
  const r = await call(method, args);
  if (method === "status") r.config = maskConfig(r.config);
  return r;
});

// ── Запись кусками на диск: закрытие окна или сбой не теряют встречу
const recDir = () => join(home(), "recordings");
const safeName = n => String(n).replace(/[^\w.-]/g, "");
ipcMain.handle("rec-chunk", (_e, name, bytes) => { mkdirSync(recDir(), { recursive: true }); const p = join(recDir(), safeName(name)); appendFileSync(p, Buffer.from(bytes)); return p; });
ipcMain.handle("rec-path", (_e, name) => join(recDir(), safeName(name)));
ipcMain.handle("rec-done", (_e, paths) => { for (const p of paths ?? []) if (p && dirname(p) === recDir() && existsSync(p)) { try { unlinkSync(p); } catch { /* занят */ } } });
/** Незавершённые записи (после сбоя или закрытия) — группируем «дата-sys/mic» */
ipcMain.handle("rec-orphans", () => {
  if (!existsSync(recDir())) return [];
  const groups = {};
  for (const f of readdirSync(recDir())) {
    const m = f.match(/^(.+)-(sys|mic)\.webm$/);
    const p = join(recDir(), f);
    if (!m || statSync(p).size < 1024) continue;
    (groups[m[1]] ??= { stamp: m[1], bytes: 0 })[m[2]] = p;
    groups[m[1]].bytes += statSync(p).size;
  }
  return Object.values(groups);
});
ipcMain.handle("version", () => pkg.version);
ipcMain.handle("check", (_e, target, cfg) => {
  // проверка подключения: в полях могут быть новые ключи, пустые — берём сохранённые
  const s = secrets();
  const fill = (k, v) => v || s[k] || "";
  if (target === "bitrix24") cfg.webhook = fill("bitrix24.webhook", cfg.webhook);
  if (target === "yougile") cfg.key = fill("yougile.key", cfg.key);
  if (target === "telegram") cfg.token = fill("telegram.token", cfg.token);
  return call("check", { target, cfg });
});
ipcMain.handle("pick-file", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Аудио и видео", extensions: ["wav", "mp3", "m4a", "ogg", "oga", "opus", "webm", "mp4", "mkv", "mov", "aac", "flac", "wma"] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("pick-dir", async () => { const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle("open", (_e, p) => shell.openPath(p));
ipcMain.handle("open-url", (_e, u) => shell.openExternal(u));
ipcMain.handle("platform", () => process.platform);

// старые временные записи v1.0 из %TEMP%
function cleanTemp() { try { rmSync(join(tmpdir(), "protokolist-rec"), { recursive: true, force: true }); } catch { /* занято */ } }

app.whenReady().then(() => { migrateSecrets(); cleanTemp(); grantLoopback(); createWindow(); watchMeetings(); if (process.env.PROTOKOLIST_SMOKE) smoke(process.env.PROTOKOLIST_SMOKE); });

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
