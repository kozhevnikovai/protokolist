// Обложка 1280×640, иконки, скриншоты приложения и пример протокола — в стиле «Чертёж»
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { analyze, toDocx, toHtml, toMarkdown, VERSION } from "../dist/index.js";
const exe = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const html = readFileSync("dist/export/html.js", "utf8");
void html;
// пример встречи для README и скриншотов
const ex = JSON.parse(readFileSync("docs/example/source.json", "utf8"));
const meeting = { transcript: ex.transcript, protocol: ex.protocol, analytics: analyze(ex.transcript, 3000) };
writeFileSync("docs/example/протокол.html", toHtml(meeting));
writeFileSync("docs/example/протокол.md", toMarkdown(meeting));
writeFileSync("docs/example/протокол.docx", await toDocx(meeting, { withTranscript: true }));
writeFileSync("docs/example/протокол-гост.docx", await toDocx({ ...meeting, protocol: { ...meeting.protocol, template: "gost" } }, { organization: "ООО «Пример»", place: "г. Чебоксары", number: "12", chair: "Анна Смирнова", secretary: "Сергей Волков", withTranscript: false }));
const fonts = toHtml(meeting).match(/<style>([\s\S]*?)<\/style>/)[1].split(":root")[0];
const css = `${fonts}*{box-sizing:border-box;margin:0}body{font-family:Geologica;color:#161616;background:#fff}.m{font-family:"Martian Mono"}`;
const glyph = (s = 1) => `<g transform="scale(${s})" fill="none" stroke="#161616">
<g stroke-width="3"><line x1="40" y1="200" x2="40" y2="232"/><line x1="64" y1="168" x2="64" y2="264"/><line x1="88" y1="186" x2="88" y2="246"/><line x1="112" y1="146" x2="112" y2="286"/><line x1="136" y1="178" x2="136" y2="254"/><line x1="160" y1="196" x2="160" y2="236"/></g>
<g stroke="#9C9C9C" stroke-width="1" stroke-dasharray="26 6 3 6"><line x1="20" y1="216" x2="354" y2="216"/></g>
<path d="M184 216 H206 M198 208 L206 216 L198 224" stroke-width="3"/>
<rect x="222" y="120" width="132" height="192" stroke-width="3"/><g stroke-width="3"><line x1="242" y1="160" x2="334" y2="160"/><line x1="242" y1="190" x2="318" y2="190"/><line x1="242" y1="220" x2="334" y2="220"/><line x1="242" y1="250" x2="300" y2="250"/></g>
<rect x="242" y="274" width="14" height="14" stroke-width="2"/><path d="M245 281 L249 285 L255 277" stroke-width="2"/><line x1="264" y1="281" x2="320" y2="281" stroke-width="1"/>
<circle cx="354" cy="120" r="16" stroke="#FF5A1F" stroke-width="2"/><circle cx="354" cy="120" r="9" fill="#FF5A1F" stroke="none"/></g>`;
const cover = `<html><head><style>${css}
.f{position:absolute;inset:20px;border:3px solid #161616;display:grid;grid-template-rows:1fr 96px}
.top{display:grid;grid-template-columns:838px 1fr;border-bottom:3px solid #161616}.l{padding:44px 46px;position:relative}.r{border-left:1px solid #5C5C5C;position:relative;display:flex;align-items:center;justify-content:center}
.tag{font-size:17px;display:flex;align-items:center;gap:12px}.dot{width:14px;height:14px;border-radius:50%;background:#FF5A1F}
h1{position:absolute;left:46px;bottom:118px;font-size:62px;line-height:1.08;font-weight:600;letter-spacing:-.5px}
.sub{position:absolute;left:46px;bottom:70px;font-size:21px}.sub2{position:absolute;left:46px;bottom:40px;font-size:16px;color:#5C5C5C}
.st{display:grid;grid-template-columns:404px 208px 208px 208px 1fr}.st div{padding:18px 22px;border-right:1px solid #161616}.st div:last-child{border:0}.st b{display:block;font:400 12px "Martian Mono";color:#5C5C5C;margin-bottom:14px}.st span{font-size:20px;font-weight:600}.st .m{font-weight:400}
</style></head><body><div class="f"><div class="top"><div class="l"><div class="tag m"><span class="dot"></span>kozhevnikovai / protokolist</div>
<h1>Протоколист</h1><div class="sub">Запись встречи → протокол с решениями, задачами и сроками</div><div class="sub2">100% локально · русский язык · Windows и macOS · Битрикс24, YouGile, Telegram</div></div>
<div class="r"><svg width="374" height="430" viewBox="0 0 374 430">${glyph()}</svg></div></div>
<div class="st"><div><b>Разработчик</b><span>Егор Кожевников</span></div><div><b>Номер</b><span class="m">№ 003</span></div><div><b>Количество шаблонов</b><span class="m">5</span></div><div><b>Версия</b><span class="m" style="color:#C8410F">v${VERSION.replace(/\.0$/, "")}</span></div><div><b>Лицензия</b><span class="m">MIT · free</span></div></div></div></body></html>`;
const icon = size => `<html><body style="margin:0"><svg width="${size}" height="${size}" viewBox="0 0 512 512"><rect width="512" height="512" fill="#fff"/><rect x="24" y="24" width="464" height="464" fill="none" stroke="#161616" stroke-width="12"/><g transform="translate(54 40) scale(1.1)">${glyph().replace(/stroke-width="3"/g, 'stroke-width="9"').replace(/stroke-width="2"/g, 'stroke-width="6"')}</g></svg></body></html>`;
const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage({ viewport: { width: 1280, height: 640 } });
await p.setContent(cover); await p.waitForTimeout(300);
await p.screenshot({ path: "docs/img/cover.png" });
for (const [path, s] of [["app/build/icon.png", 1024], ["app/ui/icon.png", 256], ["docs/img/icon.png", 512]]) {
  await p.setViewportSize({ width: s, height: s }); await p.setContent(icon(s)); await p.screenshot({ path });
}
// скриншоты: интерфейс с подставным мостом и пример протокола
const mock = `window.pk={on(){},platform:async()=>"win32",core:async m=>m==="status"?{missing:[],net:{sentBytes:0},config:{template:"planerka",offline:true},templates:${JSON.stringify([{ id: "planerka", title: "Рабочая встреча / планёрка" }])}}:m==="list"?${JSON.stringify([{ dir: "x", date: "2026-11-09", title: "Релиз приложения и найм дизайнера", duration: 1834, tasks: 4 }, { dir: "y", date: "2026-11-06", title: "Встреча с клиентом: CRM для трёх магазинов", duration: 2710, tasks: 2 }, { dir: "z", date: "2026-11-03", title: "Итоги квартала (ГОСТ)", duration: 3605, tasks: 5 }])}:[]};`;
await p.setViewportSize({ width: 1280, height: 800 });
await p.addInitScript(mock);
await p.goto("file://" + process.cwd() + "/app/ui/index.html"); await p.waitForTimeout(400);
await p.screenshot({ path: "docs/img/app-record.png" });
await p.click('nav button[data-view="archive"]'); await p.waitForTimeout(300);
await p.screenshot({ path: "docs/img/app-archive.png" });
const p2 = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p2.goto("file://" + process.cwd() + "/docs/example/протокол.html"); await p2.waitForTimeout(400);
await p2.screenshot({ path: "docs/img/protocol.png" });
await b.close();
console.log("media: ok");
