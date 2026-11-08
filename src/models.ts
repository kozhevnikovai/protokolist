// Локальные модели: где лежат, откуда скачать, проверка наличия.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
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
export const modelsDir = () => join(homeDir(), "models");

const HF = "https://huggingface.co";
const GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const ASR = "csukuangfj/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16";

export interface ModelFile { path: string; url: string; size: number }
export interface ModelPack { id: string; title: string; license: string; files: ModelFile[] }

/** Состав моделей. Размеры — для прогресса и проверки целостности. */
export const PACKS: Record<string, ModelPack> = {
  asr: {
    id: "asr", title: "Распознавание речи GigaAM v3 (Сбер), с пунктуацией", license: "MIT",
    files: [
      { path: "asr/encoder.int8.onnx", url: `${HF}/${ASR}/resolve/main/encoder.int8.onnx`, size: 224570820 },
      { path: "asr/decoder.onnx", url: `${HF}/${ASR}/resolve/main/decoder.onnx`, size: 4600132 },
      { path: "asr/joiner.onnx", url: `${HF}/${ASR}/resolve/main/joiner.onnx`, size: 2712896 },
      { path: "asr/tokens.txt", url: `${HF}/${ASR}/resolve/main/tokens.txt`, size: 13354 },
    ],
  },
  speakers: {
    id: "speakers", title: "Разделение по спикерам: Silero VAD + CAM++ (3D-Speaker)", license: "MIT / Apache-2.0",
    files: [
      { path: "vad/silero_vad.onnx", url: `${GH}/asr-models/silero_vad.onnx`, size: 643854 },
      { path: "speaker/campplus.onnx", url: `${HF}/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`, size: 28281164 },
    ],
  },
  llm: {
    id: "llm", title: "Языковая модель для протокола: Qwen3 4B Instruct (Q4_K_M)", license: "Apache-2.0",
    files: [
      { path: "llm/qwen3-4b-instruct-2507-q4_k_m.gguf", url: `${HF}/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`, size: 2497281120 },
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

export type Progress = (e: { file: string; done: number; total: number }) => void;

/** Скачивает недостающие модели. Единственный сетевой шаг в обычной работе — и только один раз. */
export async function download(packs = Object.keys(PACKS), onProgress?: Progress): Promise<void> {
  for (const f of missing(packs)) {
    const dest = modelPath(f.path);
    mkdirSync(dirname(dest), { recursive: true });
    const res = await netFetch("model-download", f.url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Не удалось скачать ${f.path}: HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || f.size;
    let done = 0;
    const src = Readable.fromWeb(res.body as any);
    src.on("data", (c: Buffer) => { done += c.length; onProgress?.({ file: f.path, done, total }); });
    await pipeline(src, createWriteStream(dest + ".part"));
    if (f.size > 0 && statSync(dest + ".part").size !== f.size) throw new Error(`Файл ${f.path} скачан не полностью — запустите загрузку ещё раз`);
    renameSync(dest + ".part", dest);
  }
}
