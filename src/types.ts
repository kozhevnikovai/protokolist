// Общие типы Протоколиста

/** Реплика стенограммы. Время — в секундах от начала записи. */
export interface Segment {
  start: number;
  end: number;
  /** Идентификатор спикера: "me" для микрофона владельца, "s1", "s2"… для остальных */
  speaker: string;
  text: string;
}

export interface Speaker {
  id: string;
  /** Отображаемое имя: «Я», «Спикер 1» или имя, заданное пользователем */
  label: string;
  /** Суммарное время речи, с */
  talk: number;
}

export interface Transcript {
  /** Имя исходного файла */
  source: string;
  /** Дата встречи (ISO, YYYY-MM-DD) */
  date: string;
  duration: number;
  speakers: Speaker[];
  segments: Segment[];
  /** Сколько секунд заняло распознавание и с каким ускорением */
  stats: { asrSeconds: number; diarSeconds: number; rtf: number; device: string };
}

export interface Quote {
  /** Цитата из стенограммы (как её дала модель) */
  quote: string;
  /** Тайм-код найденной цитаты, с; null — цитата не найдена, пункт требует проверки */
  t: number | null;
}

export interface Decision extends Quote {
  text: string;
  topic?: string;
}

export interface Task extends Quote {
  text: string;
  owner: string;
  /** Срок как сказан в речи («до пятницы») */
  dueText: string;
  /** Срок датой (YYYY-MM-DD), если удалось вычислить */
  due: string | null;
  /** Требует проверки человеком: цитата не найдена или неясен ответственный/срок */
  review: boolean;
}

export interface Topic {
  title: string;
  /** Кто докладывал / выступал — для протокола по ГОСТ («СЛУШАЛИ», «ВЫСТУПИЛИ») */
  speakers: string[];
  points: string[];
}

export interface Protocol {
  title: string;
  date: string;
  template: string;
  participants: string[];
  summary: string;
  topics: Topic[];
  decisions: Decision[];
  tasks: Task[];
  openQuestions: string[];
  /** Пункты повестки, которые не обсудили (если повестка была передана) */
  missedAgenda: string[];
  /** Особые поля шаблона (продажи: следующий шаг, возражения и т. п.) */
  extra: Record<string, string[]>;
  meta: { model: string; seconds: number; generatedAt: string };
}

export interface Analytics {
  talkShare: { speaker: string; seconds: number; percent: number }[];
  longestMonologue: { speaker: string; seconds: number; start: number };
  /** Реплики, начатые менее чем через 0,3 с после конца чужой или поверх неё */
  interruptions: { speaker: string; count: number }[];
  /** Стоимость встречи, ₽: участники × длительность × ставка */
  cost: number | null;
}
