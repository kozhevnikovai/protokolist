// HTML-протокол в стиле «Чертёж»: один файл, шрифты встроены, работает без интернета.
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
    ["Martian Mono", "@fontsource/martian-mono", "martian-mono-cyrillic-400-normal.woff2", 400, CYR], ["Martian Mono", "@fontsource/martian-mono", "martian-mono-latin-400-normal.woff2", 400, LAT],
  ];
  return f.map(([fam, pkg, file, w, r]) => {
    try { return `@font-face{font-family:"${fam}";font-weight:${w};src:url(data:font/woff2;base64,${readFileSync(require.resolve(`${pkg}/files/${file}`)).toString("base64")}) format("woff2");unicode-range:${r}}`; } catch { return ""; }
  }).join("\n");
}

const CSS = `
:root{--ink:#161616;--pencil:#5C5C5C;--axis:#9C9C9C;--plate:#E6E6E6;--sig:#FF5A1F;--sigt:#C8410F;--ok:#2F7A4B;--warn:#B07A00}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:15px/1.55 Geologica,system-ui,sans-serif}
.sheet{max-width:1040px;margin:32px auto;border:3px solid var(--ink);padding:40px 48px 0}
.mono,.tc,table.stamp td b{font-family:"Martian Mono",ui-monospace,monospace}
.kicker{font:12px "Martian Mono",monospace;color:var(--pencil);letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;gap:10px}
.kicker:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--sig)}
h1{font-size:34px;line-height:1.15;margin:10px 0 6px;font-weight:600}h2{font-size:19px;margin:36px 0 12px;font-weight:600;display:flex;gap:12px;align-items:baseline}
h2 .n{font:12px "Martian Mono",monospace;color:var(--pencil)}h3{font-size:16px;margin:18px 0 6px}
.meta{color:var(--pencil);font-size:14px}.axis{border:0;border-top:1px dashed var(--axis);margin:28px 0}
.summary{border-left:3px solid var(--ink);padding:4px 0 4px 16px;font-size:16px}
ol,ul{padding-left:22px}li{margin:4px 0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--ink);padding:8px 10px;text-align:left;vertical-align:top}th{background:var(--plate);font-weight:600;font-size:13px}
.tc{font-size:12px;color:var(--ink);background:var(--plate);padding:1px 6px;cursor:pointer;border:0;white-space:nowrap}.tc:hover{background:var(--ink);color:#fff}
.review{color:var(--sigt);font:12px "Martian Mono",monospace}.tc.bad{background:#fff;color:var(--sigt);border:1px solid var(--sigt)}
.bars div{display:grid;grid-template-columns:160px 1fr 60px;gap:12px;align-items:center;margin:6px 0}.bars i{display:block;height:10px;background:var(--ink)}.bars i.me{background:var(--sig)}
.tr p{margin:6px 0}.tr b{font-weight:600}.tr .hide{display:none}
.tools{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.tools input{flex:1;min-width:200px;border:1px solid var(--ink);padding:7px 10px;font:inherit}
button.b{border:1px solid var(--ink);background:#fff;padding:7px 12px;font:inherit;cursor:pointer}button.b:hover{background:var(--ink);color:#fff}
audio{width:100%;margin:8px 0}
table.stamp{margin:40px -48px 0;width:calc(100% + 96px);border-top:3px solid var(--ink)}table.stamp td{border:0;border-right:1px solid var(--ink);padding:10px 14px;font-size:11px;color:var(--pencil)}table.stamp td:last-child{border-right:0}table.stamp b{display:block;color:var(--ink);font-size:13px;font-weight:400}
.pill{display:inline-block;font:11px "Martian Mono",monospace;border:1px solid var(--ok);color:var(--ok);padding:2px 8px}
@media print{.tools,audio,button{display:none}.sheet{margin:0;border:0;padding:0}table.stamp{margin:30px 0 0;width:100%}}
@media (max-width:700px){.sheet{margin:0;border:0;padding:20px}.bars div{grid-template-columns:100px 1fr 44px}table.stamp{display:none}}`;

export interface HtmlOptions { /** Относительный путь к аудио рядом с отчётом */ audio?: string; /** Сколько байт данных встречи ушло в сеть (облачная модель) */ sentBytes?: number }

export function toHtml(m: Meeting, o: HtmlOptions = {}): string {
  const { transcript: tr, protocol: p, analytics: a } = m;
  const T = (t: number | null) => (t === null ? `<span class="tc bad" title="Цитата не найдена — проверьте по записи">проверить</span>` : `<button class="tc" data-t="${t}">${fmtTime(t)}</button>`);
  let n = 0;
  const H = (title: string) => `<h2><span class="n">${String(++n).padStart(2, "0")}</span>${esc(title)}</h2>`;
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
<div class="meta">${ruDate(tr.date)} · ${fmtTime(tr.duration)} · ${esc(tr.speakers.map(s => s.label).join(", "))} &nbsp;${o.sentBytes ? `<span class="pill" style="border-color:var(--warn);color:var(--warn)">● протокол составлен облачной моделью</span>` : `<span class="pill">● обработано локально · 0 байт в сеть</span>`}</div>
<hr class="axis">${S.join("\n")}
<table class="stamp"><tr><td>Разработчик<b>kozhevnikovai</b></td><td>Номер<b>№ 003</b></td><td>Решений / задач<b>${p ? `${p.decisions.length} / ${p.tasks.length}` : "—"}</b></td><td>Проверить<b>${reviews}</b></td><td>Версия<b>${VERSION}</b></td><td>Лицензия<b>MIT</b></td></tr></table>
</div><script>
const au=document.getElementById('au');
document.addEventListener('click',e=>{const b=e.target.closest('.tc[data-t]');if(!b)return;const t=+b.dataset.t;
if(au){au.currentTime=Math.max(0,t-1);au.play();}else{const ps=[...document.querySelectorAll('.tr p')];const p=ps.find(x=>+x.querySelector('.tc').dataset.t>=t)||ps[0];p.scrollIntoView({block:'center'});p.style.background='#E6E6E6';setTimeout(()=>p.style.background='',1500);}});
document.getElementById('q').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('.tr p').forEach(p=>p.classList.toggle('hide',!!q&&!p.textContent.toLowerCase().includes(q)));});
</script></body></html>`;
}
