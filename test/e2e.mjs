// Сквозная проверка распознавания на реальной речи: WER, число и точность спикеров, скорость.
import { readFileSync } from "node:fs";
import { download, transcribe } from "../dist/index.js";

const gt = JSON.parse(readFileSync(new URL("./audio/meeting-3-speakers.json", import.meta.url)));
await download(["asr", "speakers"]);
const tr = await transcribe(new URL("./audio/meeting-3-speakers.ogg", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), { date: "2026-11-09" });

const norm = s => s.toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
const ed = (a, b) => { let d = [...Array(b.length + 1).keys()]; for (let i = 1; i <= a.length; i++) { let p = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; } } return d[b.length]; };
const ref = norm(gt.map(g => g.text).join(" ")), hyp = norm(tr.segments.map(s => s.text).join(" "));
const wer = ed(ref, hyp) / ref.length * 100;
const ov = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const ids = [...new Set(tr.segments.map(s => s.speaker))];
const used = new Set(); let hit = 0;
for (const id of ids) { let best = -1, bv = 0; for (const g of [0, 1, 2]) { if (used.has(g)) continue; const v = tr.segments.filter(s => s.speaker === id).reduce((a, s) => a + gt.filter(x => x.spk === g).reduce((b, x) => b + ov(s, x), 0), 0); if (v > bv) { bv = v; best = g; } } if (best >= 0) { used.add(best); hit += bv; } }
const acc = hit / gt.reduce((a, g) => a + g.end - g.start, 0) * 100;
console.log(JSON.stringify({ wer: +wer.toFixed(1), speakers: ids.length, speakerAccuracy: +acc.toFixed(1), rtf: tr.stats.rtf, device: tr.stats.device }));
const fails = [wer > 8 && `WER ${wer.toFixed(1)}% > 8%`, ids.length !== 3 && `спикеров ${ids.length} ≠ 3`, acc < 85 && `точность спикеров ${acc.toFixed(1)}% < 85%`].filter(Boolean);
if (fails.length) { console.error("Провал: " + fails.join("; ")); process.exit(1); }

// живые субтитры на той же записи: звук кусками по 0,25 с, как из окна приложения
const { decode } = await import("../dist/audio.js");
const { LiveTranscriber } = await import("../dist/live.js");
const pcm = await decode(new URL("./audio/meeting-3-speakers.ogg", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const live = []; const t2 = Date.now();
const lt = new LiveTranscriber({ source: "others", onLine: l => live.push(l) });
for (let i = 0; i < pcm.length; i += 4096) lt.push(pcm.subarray(i, i + 4096));
lt.finish();
const liveWer = ed(ref, norm(live.map(l => l.text).join(" "))) / ref.length * 100;
const liveRtf = (Date.now() - t2) / 1000 / (pcm.length / 16000);
console.log(JSON.stringify({ liveLines: live.length, liveWer: +liveWer.toFixed(1), liveRtf: +liveRtf.toFixed(3) }));
if (liveWer > 15 || liveRtf > 0.5) { console.error(`Провал субтитров: WER ${liveWer.toFixed(1)}%, RTF ${liveRtf.toFixed(2)}`); process.exit(1); }
