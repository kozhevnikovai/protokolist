// Локальные модели: где лежат, откуда скачать, проверка наличия.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statfsSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { netFetch } from "./net.js";

export function homeDir(): string {
  if (process.env.PROTOKOLIST_HOME) return process.env.PROTOKOLIST_HOME;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "Protokolist");
  return join(homedir(), ".protokolist");
}
/**
 * Папка моделей. На Windows распознавание и языковая модель не открывают пути не на латинице
 * (например, C:\Users\Егор\…), поэтому для такой папки берём общую C:\ProgramData\Protokolist.
 */
export function modelsDir(): string {
  if (process.env.PROTOKOLIST_MODELS) return process.env.PROTOKOLIST_MODELS;
  const own = join(homeDir(), "models");
  if (process.platform === "win32" && /[^\x00-\x7F]/.test(own)) return join(process.env.ProgramData || "C:\\ProgramData", "Protokolist", "models");
  return own;
}

const HF = "https://huggingface.co";
const GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const ASR = "csukuangfj/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16";

/** sha256 — контрольная сумма с Hugging Face / GitHub; файл с другой суммой не принимается */
export interface ModelFile { path: string; url: string; size: number; sha256: string }
export interface ModelPack { id: string; title: string; license: string; files: ModelFile[] }

/** Состав моделей. Размеры — для прогресса и проверки целостности. */
export const PACKS: Record<string, ModelPack> = {
  asr: {
    id: "asr", title: "Распознавание речи GigaAM v3 (Сбер), с пунктуацией", license: "MIT",
    files: [
      { path: "asr/encoder.int8.onnx", url: `${HF}/${ASR}/resolve/main/encoder.int8.onnx`, size: 224570820, sha256: "369f35a71bf288d3b8e0391fabd8dba5f2314088d440bca474056b7b4b6e66bf" },
      { path: "asr/decoder.onnx", url: `${HF}/${ASR}/resolve/main/decoder.onnx`, size: 4600132, sha256: "38fc7475443ea2a26f63211ca350f73ac50fff824ab7a3876ee2bd610c53bbc4" },
      { path: "asr/joiner.onnx", url: `${HF}/${ASR}/resolve/main/joiner.onnx`, size: 2712896, sha256: "602ff7017a93311aad34df1437c8d7f49911353c13d6eae7a6ee7b041339465c" },
      { path: "asr/tokens.txt", url: `${HF}/${ASR}/resolve/main/tokens.txt`, size: 13354, sha256: "39abae20e692998290c574e606f11a9edef2902a1995463fcff63d1490cf22b7" },
    ],
  },
  speakers: {
    id: "speakers", title: "Разделение по спикерам: Silero VAD + CAM++ (3D-Speaker)", license: "MIT / Apache-2.0",
    files: [
      { path: "vad/silero_vad.onnx", url: `${GH}/asr-models/silero_vad.onnx`, size: 643854, sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6" },
      { path: "speaker/campplus.onnx", url: `${HF}/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`, size: 28281164, sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2" },
    ],
  },
  llm: {
    id: "llm", title: "Языковая модель для протокола: Qwen3 4B Instruct (Q4_K_M)", license: "Apache-2.0",
    files: [
      { path: "llm/qwen3-4b-instruct-2507-q4_k_m.gguf", url: `${HF}/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`, size: 2497281120, sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597" },
    ],
  },
};

export const modelPath = (p: string) => join(modelsDir(), p);

export function missing(packs = Object.keys(PACKS)): ModelFile[] {
  return packs.flatMap(id => PACKS[id].files).filter(f => {
    const p = modelPath(f.path);
    return !existsSync(p) || (f.size > 0 && statSync(p).size !== f.size);
  });
}

/** Что и зачем скачиваем — для экрана первого запуска */
export function plan(packs = Object.keys(PACKS)) {
  return packs.map(id => ({ id, title: PACKS[id].title, license: PACKS[id].license, size: PACKS[id].files.reduce((a, f) => a + f.size, 0), missing: missing([id]).length > 0 }));
}
export const totalSize = (files: ModelFile[]) => files.reduce((a, f) => a + f.size, 0);

/** Запасной адрес, если huggingface.co недоступен (бывает из России) */
const mirrors = (url: string) => [url, url.replace("https://huggingface.co/", "https://hf-mirror.com/")].filter((u, i, a) => a.indexOf(u) === i);

export type Progress = (e: { file: string; done: number; total: number; fileDone: number; fileTotal: number; index: number; count: number }) => void;

async function sha256(p: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(p), h);
  return h.digest("hex");
}

/** Есть ли место: нужно на 200 МБ больше, чем осталось скачать */
export function checkSpace(dir: string, need: number) {
  mkdirSync(dir, { recursive: true });
  try {
    const st = statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free < need + 200 * 1048576) throw new Error(`Не хватает места на диске: нужно ${(need / 1073741824).toFixed(1)} ГБ, свободно ${(free / 1073741824).toFixed(1)} ГБ. Освободите место и нажмите «Скачать» ещё раз.`);
  } catch (e) { if ((e as Error).message.startsWith("Не хватает")) throw e; /* statfs недоступен — не мешаем */ }
}

/** Скачивает недостающие модели с докачкой и проверкой SHA-256. Единственный сетевой шаг в обычной работе — и только один раз. */
export async function download(packs = Object.keys(PACKS), onProgress?: Progress): Promise<void> {
  const todo = missing(packs);
  const total = totalSize(todo);
  const partSize = (f: ModelFile) => { const p = modelPath(f.path) + ".part"; return existsSync(p) ? statSync(p).size : 0; };
  checkSpace(modelsDir(), total - todo.reduce((a, f) => a + partSize(f), 0));
  let before = 0;
  for (const [index, f] of todo.entries()) {
    const dest = modelPath(f.path);
    const part = dest + ".part";
    mkdirSync(dirname(dest), { recursive: true });
    let lastErr: Error | null = null;
    for (const url of mirrors(f.url)) {
      try {
        let have = partSize(f);
        if (have > f.size) { unlinkSync(part); have = 0; }
        if (have < f.size) {
          const res = await netFetch("model-download", url, { redirect: "follow", headers: have ? { Range: `bytes=${have}-` } : {}, signal: AbortSignal.timeout(60 * 60_000) });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          if (have && res.status !== 206) have = 0; // сервер не умеет докачку — начинаем заново
          let done = have;
          const src = Readable.fromWeb(res.body as any);
          src.on("data", (c: Buffer) => { done += c.length; onProgress?.({ file: f.path, fileDone: done, fileTotal: f.size, done: before + done, total, index, count: todo.length }); });
          await pipeline(src, createWriteStream(part, { flags: have ? "a" : "w" }));
        }
        if (statSync(part).size !== f.size) throw new Error("файл скачан не полностью — нажмите «Скачать» ещё раз, загрузка продолжится");
        if ((await sha256(part)) !== f.sha256) { unlinkSync(part); throw new Error("контрольная сумма не совпала, файл удалён — скачайте ещё раз"); }
        renameSync(part, dest);
        lastErr = null;
        break;
      } catch (e) { lastErr = e as Error; }
    }
    if (lastErr) throw new Error(`Не удалось скачать ${f.path}: ${lastErr.message}`);
    before += f.size;
  }
}
