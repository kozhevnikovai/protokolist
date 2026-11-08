// Аналитика встречи: кто сколько говорил, монологи, перебивания, стоимость.
import { speakerLabel } from "./transcribe.js";
import type { Analytics, Transcript } from "./types.js";

/** @param hourlyRate ставка участника, ₽/час — для стоимости встречи */
export function analyze(t: Transcript, hourlyRate?: number): Analytics {
  const total = t.speakers.reduce((a, s) => a + s.talk, 0) || 1;
  const talkShare = t.speakers.map(s => ({ speaker: s.label, seconds: Math.round(s.talk), percent: Math.round((s.talk / total) * 100) }))
    .sort((a, b) => b.seconds - a.seconds);
  let longest = { speaker: "", seconds: 0, start: 0 };
  for (const s of t.segments) if (s.end - s.start > longest.seconds) longest = { speaker: speakerLabel(t, s.speaker), seconds: Math.round(s.end - s.start), start: s.start };
  const inter = new Map<string, number>();
  for (let i = 1; i < t.segments.length; i++) {
    const a = t.segments[i - 1], b = t.segments[i];
    if (a.speaker !== b.speaker && b.start < a.end - 0.3) inter.set(b.speaker, (inter.get(b.speaker) ?? 0) + 1);
  }
  return {
    talkShare,
    longestMonologue: longest,
    interruptions: [...inter].map(([id, count]) => ({ speaker: speakerLabel(t, id), count })).sort((a, b) => b.count - a.count),
    cost: hourlyRate ? Math.round(t.speakers.length * (t.duration / 3600) * hourlyRate) : null,
  };
}
