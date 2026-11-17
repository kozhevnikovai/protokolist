// Пример протокола для README (docs/example). Обложка — hq/media-kit/covers.mjs, иконка — docs/img/icon.svg, скриншоты — workflow media
import { readFileSync, writeFileSync } from "node:fs";
import { analyze, toDocx, toHtml, toMarkdown } from "../dist/index.js";
// пример встречи для README и скриншотов
const ex = JSON.parse(readFileSync("docs/example/source.json", "utf8"));
const meeting = { transcript: ex.transcript, protocol: ex.protocol, analytics: analyze(ex.transcript, 3000) };
writeFileSync("docs/example/протокол.html", toHtml(meeting));
writeFileSync("docs/example/протокол.md", toMarkdown(meeting));
writeFileSync("docs/example/протокол.docx", await toDocx(meeting, { withTranscript: true }));
writeFileSync("docs/example/протокол-гост.docx", await toDocx({ ...meeting, protocol: { ...meeting.protocol, template: "gost" } }, { organization: "ООО «Пример»", place: "г. Чебоксары", number: "12", chair: "Анна Смирнова", secretary: "Сергей Волков", withTranscript: false }));
console.log("media: ok");
