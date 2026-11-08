// Декодирование любого аудио/видео (mp3, m4a, ogg из Telegram, mp4, webm, wav…) в 16 кГц моно float32.
import { spawn } from "node:child_process";
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
export function decode(file: string, channel?: 0 | 1): Promise<Float32Array> {
  const af = channel === undefined ? [] : ["-af", `pan=mono|c0=c${channel}`];
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", file, ...af, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "pipe:1"];
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", c => chunks.push(c));
    p.stderr.on("data", c => (err += c));
    p.on("error", e => reject(new Error(`Не найден ffmpeg (${e.message}). Установите пакет заново или задайте FFMPEG_PATH.`)));
    p.on("close", code => {
      if (code !== 0) return reject(new Error(`Не удалось прочитать аудио «${file}»: ${err.trim() || "код " + code}`));
      const buf = Buffer.concat(chunks);
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
    const p = spawn(ffmpegPath(), ["-hide_banner", "-i", file], { windowsHide: true });
    let s = "";
    p.stderr.on("data", c => (s += c));
    p.on("close", () => resolve(/stereo|2 channels/.test(s) ? 2 : 1));
    p.on("error", () => resolve(1));
  });
}
