// Словарь компании: имена, продукты, термины. Исправляет близкие по написанию ошибки распознавания
// («битрикс двадцать четыре» → «Битрикс24», «Кожевникав» → «Кожевников»).

export interface GlossaryEntry { term: string; /** Как это часто распознаётся — точные замены */ variants?: string[] }

export function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let p = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1));
      p = t;
    }
  }
  return d[b.length];
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Разбор словаря из текста: по строке на термин, варианты через «=»: «Битрикс24 = битрикс двадцать четыре» */
export function parseGlossary(text: string): GlossaryEntry[] {
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(l => {
    const [term, ...vars] = l.split("=").flatMap((s, i) => (i ? s.split(",") : [s])).map(s => s.trim()).filter(Boolean); // варианты через «=» или запятую
    return { term, variants: vars };
  }).filter(e => e.term && e.term.length <= MAX_TERM).map(e => ({ term: e.term, variants: e.variants.filter(v => v.length <= MAX_TERM) })).slice(0, MAX_TERMS);
}
/** Ограничения словаря: больше — распознавание заметно замедляется */
export const MAX_TERMS = 300, MAX_TERM = 80;

export function applyGlossary(text: string, entries: GlossaryEntry[]): string {
  let out = text;
  for (const e of entries) {
    for (const v of e.variants ?? []) out = out.replace(new RegExp(`(?<![\\p{L}\\d])${escape(v)}(?![\\p{L}\\d])`, "giu"), () => e.term); // функция: «$» в термине («$100») — не шаблон подстановки
    const tw = e.term.split(/\s+/).length;
    const target = norm(e.term);
    if (target.length < 5) continue; // короткие слова нечётко не правим — слишком много ложных замен
    const words = out.split(/(\s+)/); // сохраняем пробелы
    const idx = words.map((w, i) => (/\S/.test(w) ? i : -1)).filter(i => i >= 0);
    for (let k = 0; k + tw <= idx.length; k++) {
      const span = idx.slice(k, k + tw);
      const raw = span.map(i => words[i]).join(" ");
      const m = raw.match(/^([«"(]*)(.*?)([.,!?;:»")]*)$/s)!;
      const core = norm(m[2]);
      if (Math.abs(core.length - target.length) > Math.max(1, Math.floor(target.length * 0.2)) || core[0] !== target[0]) continue; // быстрый отсев: длина и первая буква
      if (core === target) { if (m[2] !== e.term) setSpan(words, span, m[1] + e.term + m[3]); continue; }
      const dist = levenshtein(core, target);
      if (dist > 0 && dist <= Math.max(1, Math.floor(target.length * 0.2)) && core[0] === target[0]) setSpan(words, span, m[1] + e.term + m[3]);
    }
    out = words.join("");
  }
  return out;
}

function setSpan(words: string[], span: number[], value: string) {
  words[span[0]] = value;
  for (const i of span.slice(1)) words[i] = "";
  // убираем лишние пробелы, оставшиеся от слитых слов
  for (let i = span[0] + 1; i <= span[span.length - 1]; i++) if (!/\S/.test(words[i])) words[i] = "";
}
