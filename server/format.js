/**
 * Как инструменты отвечают.
 *
 * Общее правило: не вываливать сырой ответ. SmartUp отдаёт документы с
 * полусотней полей, из которых человеку нужны пять, а в контекст модели
 * попадает всё. Поэтому ответ — это свод сверху и подрезанные строки снизу.
 */

/** Сколько строк отдаём по умолчанию. Больше — по явной просьбе */
export const DEFAULT_LIMIT = 25;

/** Потолок ответа: за ним начинается контекст, который никто не прочитает */
export const MAX_CHARS = 60_000;

export const DATE_HINT = 'Дата: 2026-09-06, 06.09.2026, «вчера» или «-7d».';

export function pick(row, fields) {
  if (!fields?.length) return row;
  const out = {};
  for (const f of fields) if (row?.[f] !== undefined) out[f] = row[f];
  return out;
}

/** Поиск по подстроке сразу по нескольким полям — фильтров на стороне API нет */
export function matches(row, query, fields) {
  if (!query) return true;
  const q = String(query).toLowerCase().trim();
  return fields.some((f) => String(row?.[f] ?? '').toLowerCase().includes(q));
}

export function limitOf(input, fallback = DEFAULT_LIMIT) {
  const n = Number(input?.limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 200);
}

/** Число из строки: в ответах SmartUp все числа приходят строками */
export function num(v) {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Деньги для человека: 1234567 → «1 234 567» */
export function money(v) {
  return num(v).toLocaleString('ru-RU');
}

/**
 * Свод идёт первым намеренно: если строки обрежутся по объёму, самое важное —
 * сколько всего нашлось и что с лимитами — уже сказано.
 */
export function reply(summary, rows) {
  const head = JSON.stringify(summary, null, 2);
  let body = JSON.stringify(rows, null, 2);
  if (head.length + body.length > MAX_CHARS) {
    const room = Math.max(0, MAX_CHARS - head.length);
    body = `${body.slice(0, room)}\n… ответ обрезан. Сузьте период, добавьте поиск или перечислите нужные поля в fields.`;
  }
  return { content: [{ type: 'text', text: `${head}\n\n${body}` }] };
}

export function summaryOf(res, shown, extra = {}) {
  return {
    найдено: res.items.length,
    показано: shown,
    ...extra,
    лимит_сервера: res.limits ? `осталось ${res.limits.left} из ${res.limits.limit} на сутки` : 'сервер не сообщил',
    запросов_коннектора_сегодня: `${res.spentToday} из ${res.dailyBudget}`,
  };
}
