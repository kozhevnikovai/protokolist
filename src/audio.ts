// Декодирование любого аудио/видео (mp3, m4a, ogg из Telegram, mp4, webm, wav…) в 16 кГц моно float32.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const p = require("ffmpeg-static") as string | null;
    // в собранном Electron-приложении бинарник лежит вне asar
    if (p) return p.replace("app.asar", "app.asar.unpacked");
  } catch { /* нет пакета — пробуем системный */ }
  return "ffmpeg";
}

export const RATE = 16000;

/**
 * @param channel номер канала для стереозаписи Протоколиста (0 — микрофон, 1 — звук встречи); без него — смесь в моно
 */
/** Только существующий локальный файл: никаких URL и протоколов ffmpeg (http:, concat: и т. п.) — запись не уходит в сеть */
export function checkInput(file: string) {
  if (!file || !existsSync(file)) throw new Error(`Файл не найден: ${file}`);
  const st = statSync(file);
  if (!st.isFile()) throw new Error("Это папка, а не файл записи");
  if (st.size < 1024) throw new Error("Файл пустой или повреждён — в нём нет звука");
}
const input = (file: string) => "file:" + file;
/** Самая длинная запись, которую обрабатываем за раз: дольше — не хватит памяти */
export const MAX_HOURS = 8;
/** Только локальные файлы: плейлист или «склейка» внутри файла не откроют сеть */
const SAFE = ["-protocol_whitelist", "file,pipe"];

export function decode(file: string, channel?: 0 | 1): Promise<Float32Array> {
  checkInput(file);
  const af = channel === undefined ? [] : ["-af", `pan=mono|c0=c${channel}`];
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", ...SAFE, "-i", input(file), ...af, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "pipe:1"];
  const maxBytes = MAX_HOURS * 3600 * RATE * 4;
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = "";
    let size = 0, tooLong = false;
    p.stdout.on("data", c => { size += c.length; if (size > maxBytes) { tooLong = true; p.kill(); } else chunks.push(c); });
    p.stderr.on("data", c => (err += c));
    p.on("error", e => reject(new Error(`Не найден ffmpeg (${e.message}). Установите пакет заново или задайте FFMPEG_PATH.`)));
    p.on("close", code => {
      if (tooLong) return reject(new Error(`Запись длиннее ${MAX_HOURS} часов. Разделите её на части и обработайте по очереди.`));
      if (code !== 0) return reject(new Error(/Invalid data|could not find codec|does not contain any stream|moov atom/i.test(err) ? "В этом файле нет звука, который можно прочитать. Подойдут mp3, m4a, wav, ogg, webm, mp4 и другие аудио и видео." : `Не удалось прочитать аудио: ${err.trim().split("\n").pop() || "код " + code}`));
      const buf = Buffer.concat(chunks);
      if (buf.byteLength < RATE * 4 * 0.5) return reject(new Error("Запись короче полусекунды или без звука"));
      // копия в выровненный буфер — Float32Array требует кратности 4
      const out = new Float32Array(buf.byteLength / 4);
      new Uint8Array(out.buffer).set(buf.subarray(0, out.byteLength));
      resolve(out);
    });
  });
}

/** Число каналов файла (для автоопределения стереозаписи «микрофон + встреча») */
export function channels(file: string): Promise<number> {
  return new Promise(resolve => {
    const p = spawn(ffmpegPath(), ["-hide_banner", ...SAFE, "-i", input(file)], { windowsHide: true });
    let s = "";
    p.stderr.on("data", c => (s += c));
    p.on("close", () => resolve(/stereo|2 channels/.test(s) ? 2 : 1));
    p.on("error", () => resolve(1));
  });
}

/** Сводит звук компьютера и микрофон в один файл (Opus) — чтобы в сохранённой записи был слышен и ваш голос */
export function mixTo(files: string[], out: string): Promise<void> {
  const inputs = files.flatMap(f => [...SAFE, "-i", input(f)]);
  const filter = files.length > 1 ? ["-filter_complex", `amix=inputs=${files.length}:duration=longest:normalize=0`] : [];
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...inputs, ...filter, "-ac", "1", "-c:a", "libopus", "-b:a", "64k", out];
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", c => (err += c));
    p.on("error", reject);
    p.on("close", code => (code === 0 ? resolve() : reject(new Error(`Не удалось свести запись: ${err.trim() || "код " + code}`))));
  });
}
