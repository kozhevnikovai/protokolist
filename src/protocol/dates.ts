// Сроки из живой речи → даты. Считаются от даты встречи, без модели — детерминированно.

const MONTHS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const DAYS: [RegExp, number][] = [
  [/понедельник/, 1], [/вторник/, 2], [/сред[уаы]/, 3], [/четверг/, 4], [/пятниц/, 5], [/суббот/, 6], [/воскресень/, 0],
];
const NUM: Record<string, number> = { один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, десять: 10, пару: 2 };

// порядковые числительные: «первого», «двадцать пятого», «тридцатого»
const ORD: [string, number][] = [["одиннадцат", 11], ["двенадцат", 12], ["тринадцат", 13], ["четырнадцат", 14], ["пятнадцат", 15], ["шестнадцат", 16], ["семнадцат", 17], ["восемнадцат", 18], ["девятнадцат", 19],
  ["двадцат", 20], ["тридцат", 30], ["перв", 1], ["втор", 2], ["трет", 3], ["четверт", 4], ["пят", 5], ["шест", 6], ["седьм", 7], ["восьм", 8], ["девят", 9], ["десят", 10]];
const TENS: Record<string, number> = { двадцать: 20, тридцать: 30 };
/** «двадцать пятого ноября» → «25 ноября», «до первого декабря» → «до 1 декабря» */
export function ordinalsToDigits(s: string): string {
  return s.replace(/(?:(двадцать|тридцать)\s+)?([а-я]+(?:ого|ое|ая|ой|ому|ым|ом))(?=\s|$|[.,!?])/g, (m, tens: string | undefined, w: string) => {
    const hit = ORD.find(([stem]) => w.startsWith(stem) && w.length - stem.length <= 4);
    if (!hit) return m;
    if (tens && hit[1] >= 10) return m;
    const n = (tens ? TENS[tens] : 0) + hit[1];
    return n >= 1 && n <= 31 ? String(n) : m;
  });
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const nextWeekday = (d: Date, wd: number, strict = true) => { let k = (wd - d.getDay() + 7) % 7; if (k === 0 && strict) k = 7; return addDays(d, k); };

/** @param meetingDate YYYY-MM-DD; @returns YYYY-MM-DD или null */
export function parseDue(text: string, meetingDate: string): string | null {
  if (!text) return null;
  const s = ordinalsToDigits(text.toLowerCase().replace(/ё/g, "е"));
  const [y, m, d] = meetingDate.split("-").map(Number);
  const base = new Date(y, m - 1, d);

  let r: RegExpMatchArray | null;
  if ((r = s.match(/(\d{4})-(\d{2})-(\d{2})/))) return `${r[1]}-${r[2]}-${r[3]}`;
  if ((r = s.match(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b/))) {
    let yy = r[3] ? Number(r[3]) : y;
    if (yy < 100) yy += 2000;
    let dt = new Date(yy, Number(r[2]) - 1, Number(r[1]));
    if (!r[3] && dt < base) dt = new Date(yy + 1, Number(r[2]) - 1, Number(r[1]));
    return iso(dt);
  }
  if ((r = s.match(/\b(\d{1,2})\s+([а-я]+)/))) {
    const mi = MONTHS.findIndex(p => r![2].startsWith(p) && (p !== "ма" || /^ма[яй]/.test(r![2])));
    if (mi >= 0) {
      let dt = new Date(y, mi, Number(r[1]));
      if (dt < base) dt = new Date(y + 1, mi, Number(r[1]));
      return iso(dt);
    }
  }
  if ((r = s.match(/\b(\d{1,2})(?:-?го)?\s+числа/))) {
    let dt = new Date(y, m - 1, Number(r[1]));
    if (dt < base) dt = new Date(y, m, Number(r[1]));
    return iso(dt);
  }
  if (/послезавтра/.test(s)) return iso(addDays(base, 2));
  if (/завтра/.test(s)) return iso(addDays(base, 1));
  if (/сегодня|до конца дня|к вечеру/.test(s)) return iso(base);
  if ((r = s.match(/через\s+(\d+|[а-я]+)?\s*(дн|день|недел|месяц)/))) {
    const n = r[1] ? (Number(r[1]) || NUM[r[1]] || 1) : 1;
    if (r[2].startsWith("недел")) return iso(addDays(base, 7 * n));
    if (r[2].startsWith("месяц")) { const x = new Date(base); x.setMonth(x.getMonth() + n); return iso(x); }
    return iso(addDays(base, n));
  }
  if (/кон(ец|ца|цу) года/.test(s)) return `${y}-12-31`;
  if (/кон(ец|ца|цу) месяца/.test(s)) return iso(new Date(y, m, 0));
  if (/следующ(ей|ую) недел/.test(s)) {
    const wd = DAYS.find(([re]) => re.test(s));
    return iso(nextWeekday(addDays(nextWeekday(base, 1), -1), wd ? wd[1] : 5, false));
  }
  if (/кон(ец|ца|цу) недели|на этой неделе/.test(s)) return iso(nextWeekday(base, 5, false));
  const wd = DAYS.find(([re]) => re.test(s));
  if (wd) return iso(nextWeekday(base, wd[1]));
  return null;
}
