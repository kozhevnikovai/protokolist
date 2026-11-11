// Распознавание встречи: VAD → GigaAM v3 → эмбеддинги голосов → кластеризация спикеров.
// Всё работает локально на процессоре. Для записи Протоколиста (стерео: микрофон + звук встречи)
// владелец микрофона определяется безошибочно, а спикеры ищутся только среди собеседников.
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { channels as fileChannels, decode, RATE } from "./audio.js";
import { applyGlossary, type GlossaryEntry } from "./glossary.js";
import { missing, modelPath } from "./models.js";
import type { Segment, Speaker, Transcript } from "./types.js";
import { centroidsOf, matchVoices, type Voice } from "./voices.js";

const require = createRequire(import.meta.url);

export interface TranscribeOptions {
  /** Точное число спикеров (если известно) — повышает точность */
  speakers?: number;
  /** Порог похожести голосов 0..1 (по умолчанию 0,5) */
  threshold?: number;
  /** "auto" — стерео-запись Протоколиста делится на «Я» и собеседников; "mix" — всё как один канал */
  channels?: "auto" | "mix";
  /** Отдельный файл микрофона (если запись велась в два файла) */
  micFile?: string;
  glossary?: GlossaryEntry[];
  /** Имена спикеров: { s1: "Иван" } */
  names?: Record<string, string>;
  date?: string;
  /** Знакомые голоса: узнанные спикеры подписываются сами */
  voices?: Voice[];
  threads?: number;
  onProgress?: (stage: "decode" | "vad" | "speakers" | "asr", done: number, total: number) => void;
}

interface Piece { start: number; end: number; core: Float32Array; samples: Float32Array; emb?: number[]; speaker?: string; text?: string }

let sherpa: any;
const cache: Record<string, any> = {};
function lib() {
  if (!sherpa) sherpa = require("sherpa-onnx-node");
  return sherpa;
}
function threads(o: TranscribeOptions) { return o.threads ?? Math.max(1, Math.min(8, availableParallelism() - 1)); }

function recognizer(n: number) {
  return (cache.asr ??= new (lib().OfflineRecognizer)({
    featConfig: { sampleRate: RATE, featureDim: 64 },
    modelConfig: {
      transducer: { encoder: modelPath("asr/encoder.int8.onnx"), decoder: modelPath("asr/decoder.onnx"), joiner: modelPath("asr/joiner.onnx") },
      tokens: modelPath("asr/tokens.txt"), numThreads: n, provider: "cpu", modelType: "nemo_transducer",
    },
  }));
}
function embedder(n: number) {
  return (cache.emb ??= new (lib().SpeakerEmbeddingExtractor)({ model: modelPath("speaker/campplus.onnx"), numThreads: n }));
}

/** Нарезка на фразы детектором речи; каждый кусок с запасом 0,15 с по краям, чтобы не обрезать слова */
/**
 * Тихая запись (гарнитура 3,5 мм, микрофон далеко) — поднимаем громкость до пика ≈ 0,7, не больше чем в 30 раз,
 * иначе поиск речи пропускает тихие слова.
 */
export function normalize(S: Float32Array): Float32Array {
  if (!S.length) return S;
  const step = Math.max(1, Math.floor(S.length / 200000));
  const a: number[] = [];
  for (let i = 0; i < S.length; i += step) a.push(Math.abs(S[i]));
  a.sort((x, y) => x - y);
  const p = a[Math.floor(a.length * 0.999)] || 0;
  if (p < 1e-4) return S; // тишина — не усиливаем шум
  const g = Math.min(30, 0.7 / p);
  if (g <= 1.05) return S;
  const out = new Float32Array(S.length);
  for (let i = 0; i < S.length; i++) out[i] = Math.max(-1, Math.min(1, S[i] * g));
  return out;
}

/** Короткие фразы («проверка записи») модель распознаёт лучше с тишиной по краям */
function padShort(S: Float32Array): Float32Array {
  if (S.length > RATE * 3) return S;
  const pad = Math.round(RATE * 0.5);
  const out = new Float32Array(S.length + pad * 2);
  out.set(S, pad);
  return out;
}

export function vadPieces(S: Float32Array, offset = 0): Piece[] {
  const vad = new (lib().Vad)({ sileroVad: { model: modelPath("vad/silero_vad.onnx"), threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 512 }, sampleRate: RATE, numThreads: 1 }, 120);
  const out: Piece[] = [];
  const P = Math.round(RATE * 0.15); // запас по краям, чтобы не обрезать слова
  const drain = () => {
    while (!vad.isEmpty()) {
      const s = vad.front(false);
      const a = Math.max(0, s.start - P), b = Math.min(S.length, s.start + s.samples.length + P);
      out.push({ start: offset + a / RATE, end: offset + b / RATE, samples: S.slice(a, b), core: s.samples });
      vad.pop();
    }
  };
  for (let i = 0; i < S.length; i += 512) { vad.acceptWaveform(S.subarray(i, i + 512)); drain(); }
  vad.flush();
  drain();
  return out;
}

const dot = (a: number[], b: number[]) => a.reduce((x, y, i) => x + y * b[i], 0);
const unit = (v: number[]) => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };

/**
 * Кластеризация голосов: агломеративная, средняя связь, косинус.
 * Кластеры строятся по фразам длиннее 1,5 с (у коротких эмбеддинг шумный), короткие присоединяются к ближайшему голосу.
 */
export function clusterVoices(embs: number[][], durations: number[], opts: { speakers?: number; threshold?: number } = {}): number[] {
  const th = opts.threshold ?? 0.5;
  let long = embs.map((_, i) => i).filter(i => durations[i] >= 1.5);
  if (long.length === 0) long = embs.map((_, i) => i);
  // матрица средней похожести между кластерами, обновление по Лансу — Уильямсу: O(n²) памяти, быстро и для 2-часовых встреч
  const n = long.length;
  const M = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) M[i * n + j] = M[j * n + i] = dot(embs[long[i]], embs[long[j]]);
  const members: (number[] | null)[] = long.map(i => [i]);
  let alive = n;
  while (alive > 1) {
    if (opts.speakers && alive <= opts.speakers) break;
    let bi = -1, bj = -1, bv = -2;
    for (let i = 0; i < n; i++) if (members[i]) for (let j = i + 1; j < n; j++) if (members[j] && M[i * n + j] > bv) { bv = M[i * n + j]; bi = i; bj = j; }
    if (!opts.speakers && bv < th) break;
    const ni = members[bi]!.length, nj = members[bj]!.length;
    for (let m = 0; m < n; m++) if (members[m] && m !== bi && m !== bj) M[bi * n + m] = M[m * n + bi] = (ni * M[bi * n + m] + nj * M[bj * n + m]) / (ni + nj);
    members[bi]!.push(...members[bj]!);
    members[bj] = null;
    alive--;
  }
  const C = members.filter((c): c is number[] => !!c);
  // крупные голоса — первыми; номера по порядку первого появления
  const label = new Array<number>(embs.length).fill(-1);
  C.sort((a, b) => Math.min(...a) - Math.min(...b)).forEach((c, k) => c.forEach(i => (label[i] = k)));
  const cen = C.map(c => unit(c.reduce((acc, i) => acc.map((x, d) => x + embs[i][d]), new Array(embs[0].length).fill(0))));
  return label.map((l, i) => {
    if (l >= 0) return l;
    let b = 0, bv = -2;
    cen.forEach((c, k) => { const v = dot(c, embs[i]); if (v > bv) { bv = v; b = k; } });
    return b;
  });
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\d ]/gu, " ").split(/\s+/).filter(w => w.length > 2));
function similar(a: string, b: string) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

export async function transcribe(file: string, o: TranscribeOptions = {}): Promise<Transcript> {
  const lack = missing(["asr", "speakers"]);
  if (lack.length) throw new Error(`Не хватает моделей (${lack.map(f => f.path).join(", ")}). Запустите: protokolist models`);
  const n = threads(o);
  const t0 = Date.now();
  o.onProgress?.("decode", 0, 1);
  const stereo = !o.micFile && o.channels !== "mix" && (await fileChannels(file)) === 2;
  const main = normalize(await decode(file, stereo ? 1 : undefined));
  const mic = o.micFile ? normalize(await decode(o.micFile).catch(() => new Float32Array(0))) : stereo ? normalize(await decode(file, 0)) : null;
  o.onProgress?.("decode", 1, 1);
  const duration = Math.max(main.length, mic?.length ?? 0) / RATE;

  o.onProgress?.("vad", 0, 1);
  const others = vadPieces(main);
  const mine = mic ? vadPieces(mic) : [];
  o.onProgress?.("vad", 1, 1);

  // голоса собеседников
  const ex = embedder(n);
  others.forEach((p, i) => {
    const st = ex.createStream();
    st.acceptWaveform({ sampleRate: RATE, samples: p.core });
    st.inputFinished();
    p.emb = unit(Array.from(ex.compute(st, false) as Float32Array));
    o.onProgress?.("speakers", i + 1, others.length);
  });
  if (others.length) {
    const labels = clusterVoices(others.map(p => p.emb!), others.map(p => p.end - p.start), { speakers: o.speakers ? o.speakers - (mic ? 1 : 0) || 1 : undefined, threshold: o.threshold });
    others.forEach((p, i) => (p.speaker = `s${labels[i] + 1}`));
  }
  mine.forEach(p => (p.speaker = "me"));
  const diarSeconds = (Date.now() - t0) / 1000;
  const voices = centroidsOf(others);
  const known = o.voices ? matchVoices(voices, o.voices) : {};

  // распознавание
  const t1 = Date.now();
  const rec = recognizer(n);
  const all = [...others, ...mine];
  all.forEach((p, i) => {
    const st = rec.createStream();
    st.acceptWaveform({ sampleRate: RATE, samples: padShort(p.samples) });
    rec.decode(st);
    p.text = String(rec.getResult(st).text ?? "").trim();
    if (o.glossary?.length) p.text = applyGlossary(p.text, o.glossary);
    o.onProgress?.("asr", i + 1, all.length);
  });
  const asrSeconds = (Date.now() - t1) / 1000;

  // эхо: без наушников микрофон слышит колонки — убираем фразы «Я», повторяющие собеседника
  const kept = all.filter(p => p.text && !(p.speaker === "me" && others.some(q =>
    Math.min(p.end, q.end) - Math.max(p.start, q.start) > 0.5 * (p.end - p.start) && similar(p.text!, q.text!) > 0.5)));

  // склеиваем подряд идущие фразы одного спикера (пауза < 1,2 с)
  kept.sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  for (const p of kept) {
    const last = segments[segments.length - 1];
    if (last && last.speaker === p.speaker && p.start - last.end < 1.2 && last.end - last.start < 60) { last.end = p.end; last.text += " " + p.text; }
    else segments.push({ start: round(p.start), end: round(p.end), speaker: p.speaker!, text: p.text! });
  }
  for (const s of segments) s.end = round(s.end);

  const talk = new Map<string, number>();
  for (const s of segments) talk.set(s.speaker, (talk.get(s.speaker) ?? 0) + s.end - s.start);
  const speakers: Speaker[] = [...talk.keys()].sort((a, b) => (a === "me" ? -1 : b === "me" ? 1 : a.localeCompare(b, "ru", { numeric: true })))
    .map(id => ({ id, label: o.names?.[id] ?? known[id] ?? (id === "me" ? "Я" : `Спикер ${id.slice(1)}`), talk: round(talk.get(id)!), ...(known[id] && !o.names?.[id] ? { known: true } : {}) }));

  return {
    source: basename(file),
    date: o.date ?? new Date().toISOString().slice(0, 10),
    duration: round(duration),
    speakers, segments, voices,
    stats: { asrSeconds: round(asrSeconds), diarSeconds: round(diarSeconds), rtf: round((asrSeconds + diarSeconds) / Math.max(duration, 1), 3), device: `CPU, ${n} потоков` },
  };
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** Переименование спикеров после распознавания: { s1: "Иван Петров" } */
export function renameSpeakers(t: Transcript, names: Record<string, string>): Transcript {
  return { ...t, speakers: t.speakers.map(s => (names[s.id] ? { ...s, label: names[s.id], known: undefined } : s)) };
}

export const speakerLabel = (t: Transcript, id: string) => t.speakers.find(s => s.id === id)?.label ?? id;

export function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const p = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/** Текст стенограммы для модели и для чтения: [мм:сс] Имя: реплика */
export function transcriptText(t: Transcript): string {
  return t.segments.map(s => `[${fmtTime(s.start)}] ${speakerLabel(t, s.speaker)}: ${s.text}`).join("\n");
}
