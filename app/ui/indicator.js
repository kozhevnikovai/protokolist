// Индикатор записи поверх окон: время и кнопка «Стоп». Доступ — только к двум методам моста.
const t = document.getElementById("t");
window.pkInd.onTick(text => { t.textContent = String(text).slice(0, 12); });
document.getElementById("stop").addEventListener("click", () => window.pkInd.command("toggle"));
document.querySelector(".bar").addEventListener("dblclick", () => window.pkInd.command("show"));
