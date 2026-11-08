// Evals протокола: стенограммы встреч с эталонными задачами, решениями и сроками.
// Запуск: npm run eval (локальная модель) · EVAL_LLM_URL/EVAL_LLM_MODEL/EVAL_LLM_KEY — облачная.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildProtocol, createLLM } from "../dist/index.js";

const dir = new URL("./meetings/", import.meta.url);
const args = process.argv.slice(2);
const saveExample = args.includes("--save-example");
const only = args.find(a => !a.startsWith("--"));
const files = readdirSync(dir).filter(f => f.endsWith(".json")).filter(f => !only || f.includes(only));
const low = s => String(s ?? "").toLowerCase().replace(/ё/g, "е");
const has = (s, words) => words.some(w => low(s).includes(low(w)));
const all = (s, words) => words.every(w => low(s).includes(low(w)));

const llm = await createLLM(process.env.EVAL_LLM_URL
  ? { provider: "openai", baseUrl: process.env.EVAL_LLM_URL, model: process.env.EVAL_LLM_MODEL, apiKey: process.env.EVAL_LLM_KEY }
  : { provider: "local", gpu: process.env.PROTOKOLIST_GPU });
console.log(`Модель: ${llm.name}\n`);
const rows = [];
for (const f of files) {
  const c = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
  const ids = Object.keys(c.speakers);
  const segments = c.lines.map(([sp, text], i) => ({ start: i * 12, end: i * 12 + 11, speaker: sp, text }));
  const tr = { source: f, date: c.date, duration: segments.length * 12, segments,
    speakers: ids.map(id => ({ id, label: c.speakers[id], talk: 0 })), stats: { asrSeconds: 0, diarSeconds: 0, rtf: 0, device: "" } };
  const t0 = Date.now();
  const p = await buildProtocol(tr, llm, { template: c.template });
  const sec = (Date.now() - t0) / 1000;
  if (saveExample && f.startsWith("01")) writeFileSync(new URL("../docs/example/source.json", import.meta.url), JSON.stringify({ transcript: tr, protocol: p }, null, 1));
  const e = c.expect;
  const matchTask = (x, t) => all(`${t.text} ${t.quote}`, x.words);
  const found = e.tasks.map(x => p.tasks.find(t => matchTask(x, t)));
  const recall = found.filter(Boolean).length / e.tasks.length;
  const owner = found.filter((t, i) => t && low(t.owner).includes(low(e.tasks[i].owner).split(" ").pop().slice(0, 4))).length / e.tasks.length;
  const due = found.filter((t, i) => t && t.due === e.tasks[i].due).length / e.tasks.length;
  const precision = p.tasks.length ? p.tasks.filter(t => e.tasks.some(x => matchTask(x, t))).length / p.tasks.length : 0;
  const items = [...p.tasks, ...p.decisions];
  const grounded = items.length ? items.filter(x => x.t !== null).length / items.length : 0;
  const dec = e.decisions.filter(w => p.decisions.some(d => all(`${d.text} ${d.quote}`, w))).length / e.decisions.length;
  const open = e.open ? e.open.filter(w => [...p.openQuestions, ...p.decisions.map(d => d.text)].some(q => all(q, w))).length / e.open.length : null;
  const extra = e.extra ? Object.entries(e.extra).filter(([k, w]) => (p.extra[k] ?? []).some(s => has(s, w))).length / Object.keys(e.extra).length : null;
  rows.push({ meeting: f, recall, owner, due, precision, grounded, decisions: dec, open, extra, seconds: Math.round(sec), tasks: p.tasks.map(t => `${t.text} | ${t.owner} | ${t.due ?? t.dueText} | ${t.t === null ? "нет цитаты" : "ок"}`) });
  const pct = v => (v === null ? "  —" : `${Math.round(v * 100)}%`.padStart(4));
  console.log(`${f.padEnd(18)} задачи ${pct(recall)} · ответств. ${pct(owner)} · сроки ${pct(due)} · точность ${pct(precision)} · цитаты ${pct(grounded)} · решения ${pct(dec)} · открытые ${pct(open)} · поля ${pct(extra)} · ${Math.round(sec)} с`);
}
await llm.dispose();
const avg = k => { const v = rows.map(r => r[k]).filter(x => x !== null); return v.reduce((a, b) => a + b, 0) / v.length; };
const summary = Object.fromEntries(["recall", "owner", "due", "precision", "grounded", "decisions", "open", "extra"].map(k => [k, Math.round(avg(k) * 100)]));
console.log("\nИтого, %:", summary);
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ model: llm.name, date: new Date().toISOString().slice(0, 10), summary, rows }, null, 2));
const gate = { recall: 75, owner: 70, due: 70, precision: 70, grounded: 80 };
const fail = Object.entries(gate).filter(([k, v]) => summary[k] < v);
if (fail.length) { console.error(`Ниже порога: ${fail.map(([k, v]) => `${k} ${summary[k]} < ${v}`).join(", ")}`); process.exit(1); }
