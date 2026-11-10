// HTML-протокол в светлом стиле приложений kozhevnikovai: один файл, шрифты встроены, работает без интернета.
// Тайм-коды кликабельны: если рядом лежит аудио, фрагмент проигрывается с нужного места.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { getTemplate } from "../protocol/templates.js";
import { fmtTime, speakerLabel } from "../transcribe.js";
import { VERSION } from "../version.js";
import type { Meeting } from "./text.js";

const require = createRequire(import.meta.url);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const ruDate = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };

function fontFaces(): string {
  const CYR = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116", LAT = "U+0000-00FF,U+2000-206F,U+20AC,U+2122,U+2190-2193";
  const f: [string, string, string, number, string][] = [
    ["Geologica", "@fontsource/geologica", "geologica-cyrillic-400-normal.woff2", 400, CYR], ["Geologica", "@fontsource/geologica", "geologica-latin-400-normal.woff2", 400, LAT],
    ["Geologica", "@fontsource/geologica", "geologica-cyrillic-600-normal.woff2", 600, CYR], ["Geologica", "@fontsource/geologica", "geologica-latin-600-normal.woff2", 600, LAT],
  ];
  return f.map(([fam, pkg, file, w, r]) => {
    try { return `@font-face{font-family:"${fam}";font-weight:${w};src:url(data:font/woff2;base64,${readFileSync(require.resolve(`${pkg}/files/${file}`)).toString("base64")}) format("woff2");unicode-range:${r}}`; } catch { return ""; }
  }).join("\n");
}

const CSS = `
:root{--bg:#FBFBFA;--card:#fff;--ink:#1A1A19;--pencil:#5C5C57;--line:#E8E8E5;--plate:#F1F1EE;--acc:#C2410C;--ok:#1F7A4A;--okbg:#E7F3EC;--warn:#9A5B00;--warnbg:#FFF3DF;--bad:#B3261E;--badbg:#FCE9E7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 Geologica,"Segoe UI",system-ui,sans-serif}
.sheet{max-width:980px;margin:32px auto;padding:0 20px 40px}
.mono,.tc{font-variant-numeric:tabular-nums}
.kicker{font-size:13px;font-weight:600;color:var(--acc);display:flex;align-items:center;gap:8px}
h1{font-size:30px;line-height:1.2;margin:8px 0 8px;font-weight:600;letter-spacing:-.01em}h2{font-size:18px;margin:0 0 12px;font-weight:600}h2 .n{display:none}h3{font-size:15px;margin:16px 0 6px}
.meta{color:var(--pencil);font-size:14px}.axis{display:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin:16px 0;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0 8px}.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.tile b{display:block;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}.tile span{font-size:13px;color:var(--pencil)}.tile.warn b{color:var(--warn)}
.summary{font-size:16px;margin:0}
ol,ul{padding-left:22px;margin:0}li{margin:4px 0}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:9px 10px;text-align:left;vertical-align:top}th{background:var(--plate);color:var(--pencil);font-weight:600;font-size:13px}tr:last-child td{border-bottom:0}
.tc{font-size:12px;color:var(--ink);background:var(--plate);padding:2px 8px;cursor:pointer;border:0;border-radius:999px;white-space:nowrap;font-family:inherit}.tc:hover{background:var(--acc);color:#fff}
.review{color:var(--bad);font-size:12px;font-weight:600}.tc.bad{background:var(--badbg);color:var(--bad)}
.bars div{display:grid;grid-template-columns:160px 1fr 60px;gap:12px;align-items:center;margin:8px 0}.bars i{display:block;height:10px;border-radius:5px;background:#A8A8A2}.bars i.me{background:var(--acc)}
.tr p{margin:6px 0}.tr b{font-weight:600}.tr .hide{display:none}
.tools{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.tools input{flex:1;min-width:200px;border:1px solid var(--line);border-radius:10px;padding:9px 12px;font:inherit;background:#fff}.tools input:focus{outline:2px solid var(--acc);outline-offset:1px}
button.b{border:1px solid var(--line);border-radius:10px;background:#fff;padding:8px 14px;font:inherit;cursor:pointer}button.b:hover{background:var(--plate)}
button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
audio{width:100%;margin:8px 0}
.foot{margin-top:28px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--pencil)}
.pill{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;background:var(--okbg);color:var(--ok);padding:2px 10px}.pill.cloud{background:var(--warnbg);color:var(--warn)}
@media print{body{background:#fff}.tools,audio,button.b{display:none}.sheet{margin:0;padding:0}.card{box-shadow:none;break-inside:avoid}}
@media (max-width:700px){.sheet{margin:0;padding:16px}.card{padding:16px}.bars div{grid-template-columns:100px 1fr 44px}}`;

export interface HtmlOptions { /** Относительный путь к аудио рядом с отчётом */ audio?: string; /** Сколько байт данных встречи ушло в сеть (облачная модель) */ sentBytes?: number }

export function toHtml(m: Meeting, o: HtmlOptions = {}): string {
  const { transcript: tr, protocol: p, analytics: a } = m;
  const T = (t: number | null) => (t === null ? `<span class="tc bad" title="Цитата не найдена — проверьте по записи">проверить</span>` : `<button class="tc" data-t="${t}">${fmtTime(t)}</button>`);
  let n = 0;
  // каждый раздел — отдельная карточка: заголовок открывает её, следующий заголовок закрывает предыдущую
  const H = (title: string) => `${n++ ? "</section>" : ""}<section class="card"><h2>${esc(title)}</h2>`;
  const S: string[] = [];
  if (p) {
    if (p.meta.warnings?.length) S.push(p.meta.warnings.map(w => `<p class="review">● ${esc(w)}</p>`).join(""));
    if (p.summary) S.push(H("Кратко"), `<p class="summary">${esc(p.summary)}</p>`);
    if (p.decisions.length) S.push(H("Решения"), `<ol>${p.decisions.map(d => `<li>${esc(d.text)} ${T(d.t)}</li>`).join("")}</ol>`);
    if (p.tasks.length) S.push(H("Задачи"), `<table><tr><th>№</th><th>Задача</th><th>Ответственный</th><th>Срок</th><th>Где сказано</th></tr>${p.tasks.map((t, i) =>
      `<tr><td class="mono">${i + 1}</td><td>${esc(t.text)}${t.review ? `<div class="review">● проверить</div>` : ""}</td><td>${esc(t.owner || "—")}</td><td class="mono">${t.due ? ruDate(t.due) : esc(t.dueText || "—")}</td><td>${T(t.t)}</td></tr>`).join("")}</table>`);
    const tpl = getTemplate(p.template);
    for (const [k, items] of Object.entries(p.extra)) if (items.length) S.push(H(tpl.extraTitles[k] ?? k), `<ul>${items.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`);
    if (p.topics.length) S.push(H("Ход обсуждения"), p.topics.map(t => `<h3>${esc(t.title)}</h3>${t.speakers.length ? `<div class="meta">${esc(t.speakers.join(", "))}</div>` : ""}<ul>${t.points.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`).join(""));
    if (p.openQuestions.length) S.push(H("Открытые вопросы"), `<ul>${p.openQuestions.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`);
    if (p.missedAgenda.length) S.push(H("Не обсудили из повестки"), `<ul>${p.missedAgenda.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`);
  }
  if (a) {
    const max = Math.max(...a.talkShare.map(s => s.percent), 1);
    S.push(H("Кто сколько говорил"), `<div class="bars">${a.talkShare.map(s => `<div><span>${esc(s.speaker)}</span><i class="${s.speaker === "Я" ? "me" : ""}" style="width:${(s.percent / max) * 100}%"></i><span class="mono">${s.percent}%</span></div>`).join("")}</div>`,
      `<p class="meta">Самый длинный монолог: ${esc(a.longestMonologue.speaker)}, ${fmtTime(a.longestMonologue.seconds)}${a.cost ? ` · стоимость встречи ≈ ${a.cost.toLocaleString("ru-RU")} ₽` : ""}</p>`);
  }
  S.push(H("Стенограмма"), `<div class="tools"><input id="q" placeholder="Поиск по стенограмме"><button class="b" onclick="print()">Печать / PDF</button></div>`,
    o.audio ? `<audio id="au" controls preload="none" src="${esc(o.audio)}"></audio>` : "",
    `<div class="tr">${tr.segments.map(s => `<p>${T(s.start)} <b>${esc(speakerLabel(tr, s.speaker))}:</b> ${esc(s.text)}</p>`).join("")}</div>`);

  const reviews = p ? p.tasks.filter(t => t.review).length : 0;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p?.title ?? "Стенограмма")} — ${ruDate(tr.date)}</title><style>${fontFaces()}${CSS}</style></head><body><div class="sheet">
<div class="kicker">Протоколист · ${p ? esc(getTemplate(p.template).title) : "стенограмма"}</div>
<h1>${esc(p?.title ?? "Стенограмма встречи")}</h1>
<div class="meta">${ruDate(tr.date)} · ${fmtTime(tr.duration)} · ${esc(tr.speakers.map(s => s.label).join(", "))} &nbsp;${o.sentBytes ? `<span class="pill cloud">● протокол составлен облачной моделью</span>` : `<span class="pill">● обработано локально · 0 байт в сеть</span>`}</div>
<div class="tiles">${p ? `<div class="tile"><b>${p.decisions.length}</b><span>решений</span></div><div class="tile"><b>${p.tasks.length}</b><span>задач</span></div>` : ""}<div class="tile${reviews ? " warn" : ""}"><b>${reviews}</b><span>проверить по записи</span></div><div class="tile"><b>${fmtTime(tr.duration)}</b><span>длительность</span></div></div>
${S.join("\n")}${n ? "</section>" : ""}
<div class="foot">Протоколист ${VERSION} · kozhevnikovai · MIT</div>
</div><script>
const au=document.getElementById('au');
document.addEventListener('click',e=>{const b=e.target.closest('.tc[data-t]');if(!b)return;const t=+b.dataset.t;
if(au){au.currentTime=Math.max(0,t-1);au.play();}else{const ps=[...document.querySelectorAll('.tr p')];const p=ps.find(x=>+x.querySelector('.tc').dataset.t>=t)||ps[0];p.scrollIntoView({block:'center'});p.style.background='#FFF3DF';setTimeout(()=>p.style.background='',1500);}});
document.getElementById('q').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('.tr p').forEach(p=>p.classList.toggle('hide',!!q&&!p.textContent.toLowerCase().includes(q)));});
</script></body></html>`;
}
