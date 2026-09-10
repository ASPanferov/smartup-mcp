import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Клиент SmartUp: авторизация, разбор ответов, суточные лимиты и запрет записи.
 *
 * Три вещи, которые определяют здесь всё:
 *
 *  - API отвечает POST-ом на всё, включая чтение, и ошибки присылает то
 *    русским текстом, то JSON-ом с кодом 200. «Ответ пришёл» здесь не значит
 *    «всё хорошо»;
 *  - суточные лимиты общие с боевой работой заказчика: справочники ~100
 *    вызовов в день, документы 300–500. Коннектор, выбравший лимит из
 *    любопытства, останавливает не себя, а отгрузку;
 *  - учётная система — источник правды о деньгах и остатках. Поэтому запись
 *    закрыта наглухо, а не спрятана за флажок.
 */

/** Базовый адрес по умолчанию. Меняется в настройках расширения */
const DEFAULT_BASE = 'https://smartup.online';

/** Дольше ждать нет смысла: SmartUp либо отвечает за секунды, либо не отвечает */
const TIMEOUT_MS = 45_000;

/**
 * Справочник эндпоинтов.
 *
 * `entity` — корневой ключ в ответе. `budget` — какой суточный лимит тратит
 * вызов. Ловушка в product_price: путь /api/v2/, а корневой ключ всё равно
 * `inventory`, не `data`.
 */
export const EP = {
  // Справочники — лимит около сотни вызовов в сутки
  inventory: { path: '/b/anor/mxsx/mr/inventory$export', entity: 'inventory', budget: 'refs' },
  productGroup: { path: '/b/anor/mxsx/mr/product_group$export', entity: 'product_group', budget: 'refs' },
  producer: { path: '/b/anor/mxsx/mr/producer$export', entity: 'producer', budget: 'refs' },
  legalPerson: { path: '/b/anor/mxsx/mr/legal_person$export', entity: 'legal_person', budget: 'refs' },
  naturalPerson: { path: '/b/anor/mxsx/mr/natural_person$export', entity: 'natural_person', budget: 'refs' },
  room: { path: '/b/anor/mxsx/mrf/room$export', entity: 'room', budget: 'refs' },
  contract: { path: '/b/anor/mxsx/mkf/contract$export', entity: 'contract', budget: 'refs' },
  priceType: { path: '/b/anor/api/v2/mkr/price_type$export', entity: 'price_type', budget: 'refs' },
  productPrice: { path: '/b/anor/api/v2/mkf/product_price$export', entity: 'inventory', budget: 'refs' },

  // Документы — лимит в несколько сотен
  balance: { path: '/b/anor/mxsx/mkw/balance$export', entity: 'balance', budget: 'docs' },
  orderExport: { path: '/b/trade/txs/tdeal/order$export', entity: 'order', budget: 'docs' },
  logistics: { path: '/b/trade/txs/tdeal/logistics$export', entity: 'logistics', budget: 'docs' },
  cashin: { path: '/b/trade/txs/tcs/cashin$export', entity: 'cashin', budget: 'docs' },
  // Возвраты живут в anor/mxsx/mdeal, а не в trade — исключение из общего правила
  returnExport: { path: '/b/anor/mxsx/mdeal/return$export', entity: 'return', budget: 'docs' },

  /*
   * Пишущие методы. Доступны, только когда в настройках включён режим
   * записи, и только в филиал, названный там же.
   *
   * `entity: 'successes'` — ответ импорта это {successes, errors}, а не
   * список сущностей: причина отказа лежит в errors[].message, и без разбора
   * тела целиком отказ выглядел бы как «ничего не вернулось».
   */
  orderImport: { path: '/b/trade/txs/tdeal/order$import', entity: 'successes', budget: 'docs', write: true },
  orderChangeStatus: { path: '/b/trade/txs/tdeal/order$change_status', entity: 'successes', budget: 'docs', write: true },
  orderAttachData: { path: '/b/trade/txs/tdeal/order$attach_data', entity: 'successes', budget: 'docs', write: true },
  legalPersonImport: { path: '/b/anor/mxsx/mr/legal_person$import', entity: 'successes', budget: 'refs', write: true },
};

export class SmartUpError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SmartUpError';
    Object.assign(this, meta);
  }
}

/* ── Настройки ─────────────────────────────────────────────── */

export function readConfig(env = process.env) {
  const login = (env.SMARTUP_LOGIN ?? '').trim();
  const password = env.SMARTUP_PASSWORD ?? '';
  if (!login || !password) {
    throw new SmartUpError(
      'Не заданы логин и пароль SmartUp. Откройте Настройки → Расширения → SmartUp и заполните поля.',
    );
  }
  const budget = Number(env.SMARTUP_DAILY_BUDGET ?? 60);
  return {
    baseUrl: (env.SMARTUP_BASE_URL || DEFAULT_BASE).trim().replace(/\/+$/, ''),
    login,
    password,
    filial: (env.SMARTUP_FILIAL_CODE ?? '').trim(),
    // Свой предохранитель поверх серверного: он считает ВСЕ вызовы за сутки и
    // не даёт коннектору в чате съесть лимит, которым живёт отгрузка
    dailyBudget: Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 60,
    /*
     * Режим записи. По умолчанию выключен и включается галочкой в настройках
     * расширения — осознанно, а не по умолчанию: на другом конце учётная
     * система заказчика, где заказ, проведённый по ошибке, едет на склад.
     */
    allowWrite: ['true', '1', 'yes', 'on', 'да'].includes(String(env.SMARTUP_ALLOW_WRITE ?? '').trim().toLowerCase()),
  };
}

/* ── Счётчик вызовов за сутки ──────────────────────────────── */

const USAGE_FILE = join(homedir(), '.smartup-connector', 'usage.json');

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function readUsage() {
  try {
    const raw = JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
    if (raw?.date === today()) return { date: raw.date, calls: Number(raw.calls) || 0, byPath: raw.byPath ?? {} };
  } catch {
    // Файла нет или он испорчен — считаем с нуля: счётчик это подсказка,
    // а не бухгалтерия, и падать из-за него нельзя
  }
  return { date: today(), calls: 0, byPath: {} };
}

function bumpUsage(path) {
  const usage = readUsage();
  usage.calls += 1;
  usage.byPath[path] = (usage.byPath[path] ?? 0) + 1;
  try {
    mkdirSync(dirname(USAGE_FILE), { recursive: true });
    writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch {
    // Не записали — не беда: в худшем случае предохранитель сбросится
  }
  return usage;
}

/* ── Запрет записи ─────────────────────────────────────────── */

/**
 * Читающий путь — только `$export`. Всё остальное с долларом (`$import`,
 * `$change_status`, `$attach_data`) меняет учётную систему.
 *
 * Проверка идёт по «разрешено только это», а не по списку запрещённых:
 * завтра в API появится `$cancel`, и список запрещённых промолчит.
 */
export function isReadPath(path) {
  return /\$export$/.test(String(path ?? '').trim());
}

/** Путь что-то меняет: есть `$`, но это не `$export` */
export function isWritePath(path) {
  const p = String(path ?? '').trim();
  return p.includes('$') && !isReadPath(p);
}

/** Филиал, в который метит запрос: из шапки или из первой строки массива */
export function filialOf(body) {
  if (!body || typeof body !== 'object') return '';
  const direct = body.filial_code;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  for (const value of Object.values(body)) {
    if (!Array.isArray(value)) continue;
    const nested = value[0]?.filial_code;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return '';
}

/**
 * Можно ли выполнить этот запрос.
 *
 * Чтение — всегда. Запись — три условия подряд, и каждое закрывает свою беду:
 *
 *  1. режим записи включён в настройках. Иначе разговор в чате не должен
 *     уметь трогать учётную систему вовсе;
 *  2. филиал в запросе назван. Запрос БЕЗ филиала сервер обслуживает «по
 *     умолчанию», а умолчание — основная организация учётной записи, то есть
 *     чаще всего боевой контур;
 *  3. филиал совпадает с тем, что задан в настройках. Так галочка «разрешить
 *     запись» открывает ровно один контур, а не всю организацию.
 */
export function assertAllowed(path, cfg, body) {
  if (isReadPath(path)) return;
  if (!isWritePath(path)) {
    throw new SmartUpError(`Метод «${path}» непохож ни на чтение, ни на запись — коннектор его не выполняет.`);
  }
  if (!cfg.allowWrite) {
    throw new SmartUpError(
      `«${path}» меняет данные в учётной системе, а режим записи выключен. ` +
        'Включите «Разрешить изменение данных» в настройках расширения — и учтите, что после этого ' +
        'разговор в чате сможет заводить заказы и менять их статусы.',
    );
  }
  const allowed = (cfg.filial ?? '').trim();
  if (!allowed) {
    throw new SmartUpError(
      'Запись включена, но код филиала в настройках не задан. Без него сервер выполнит запрос по филиалу ' +
        'по умолчанию — а это чаще всего боевой контур. Укажите филиал в настройках расширения.',
    );
  }
  const target = filialOf(body);
  if (!target) {
    throw new SmartUpError('В запросе не назван филиал. Запись без филиала запрещена.');
  }
  if (target !== allowed) {
    throw new SmartUpError(
      `Запись разрешена только в филиал ${allowed}, а запрос адресован филиалу ${target}.`,
    );
  }
}

/** Оставлено для совместимости: раньше коннектор умел только читать */
export function assertReadOnly(path) {
  if (!isReadPath(path)) throw new SmartUpError(`«${path}» не является методом чтения`);
}

/**
 * Подсказка к отказу учётной системы.
 *
 * Отказы приходят на языке Oracle и говорят о внутренностях («Штат не
 * найден»), а не о том, чего не хватило в запросе. Без перевода человек
 * читает такое сообщение как поломку коннектора и идёт чинить не туда.
 */
function hintFor(message) {
  const m = String(message).toLowerCase();
  if (m.includes('штат')) {
    /*
     * Сообщение врёт, и это стоило нескольких часов вслепую: штат учётная
     * система выводит ИЗ РАБОЧЕЙ ЗОНЫ, и, не найдя зоны, жалуется на пустой
     * штат. Человек идёт искать менеджера, а не хватает room_code.
     */
    return (
      '. Чаще всего это значит, что не передан room_code: штат учётная система выводит из рабочей зоны ' +
      'и, не найдя зоны, сообщает о пустом штате. Посмотрите рабочие коды инструментом smartup_order_defaults.'
    );
  }
  if (m.includes('склад')) {
    return '. Похоже, в этом контуре обязателен код склада в строке заказа — передайте warehouse_code (список: smartup_reference с name=room или коды из smartup_stock).';
  }
  if (m.includes('рабочая зона') || m.includes('room')) {
    return '. Похоже, нужен код рабочей зоны — передайте room_code (список: smartup_reference с name=room).';
  }
  if (m.includes('номер партии') || m.includes('a02-02-024')) {
    return '. Не хватает остатка по партии: уменьшите количество или отгружайте с другого склада.';
  }
  if (m.includes('a02-05-003') || m.includes('дубл')) {
    return '. Такое название уже занято: в учётной системе имя юрлица уникально на всю организацию.';
  }
  if (m.includes('a02-13-170') || m.includes('цена')) {
    return '. Спорная цена: проверьте price_type_code и цену позиции.';
  }
  if (m.includes('date') || m.includes('дата')) {
    return '. Проверьте формат даты: учётная система принимает дд.мм.гггг.';
  }
  return '';
}

/**
 * Разбор ответа импорта.
 *
 * HTTP 200 приходит и на успех, и на отказ — различает их только тело.
 * Пустой `successes` при пустом `errors` тоже отказ: значит сервер не принял
 * ничего и не сказал почему.
 */
export function importResult(json) {
  const successes = Array.isArray(json?.successes) ? json.successes : [];
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const message = errors
    .map((e) => String(e?.message ?? '').trim())
    .filter(Boolean)
    .join('; ');
  if (message) throw new SmartUpError(`Учётная система отклонила запрос: ${message}${hintFor(message)}`);
  if (successes.length === 0) {
    throw new SmartUpError('Учётная система ничего не приняла и не объяснила причину');
  }
  return successes;
}

/* ── Даты ──────────────────────────────────────────────────── */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const RU = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/**
 * SmartUp понимает только `дд.мм.гггг`. Принимаем ещё и ISO с относительными
 * словами: модель зовёт инструмент со «вчера» гораздо чаще, чем с датой.
 */
export function toSmartUpDate(value, fallbackDays = 0) {
  const raw = String(value ?? '').trim().toLowerCase();
  const shift = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  };

  if (!raw) return shift(fallbackDays);
  if (RU.test(raw)) return raw;
  if (ISO.test(raw)) {
    const [, y, m, d] = ISO.exec(raw);
    return `${d}.${m}.${y}`;
  }
  if (raw === 'сегодня' || raw === 'today') return shift(0);
  if (raw === 'вчера' || raw === 'yesterday') return shift(-1);
  const rel = /^-(\d+)\s*(d|дн|день|дня|дней)?$/.exec(raw);
  if (rel) return shift(-Number(rel[1]));

  throw new SmartUpError(`Дату «${value}» не разобрать. Ожидается 2026-09-06, 06.09.2026, «вчера» или «-7d».`);
}

/* ── Разбор ответа ─────────────────────────────────────────── */

/**
 * SmartUp отвечает в двух несовместимых формах:
 *   A (почти всё):     { "<entity>": [...], "limits": {...} }
 *   B (только /api/v2): { "count": "1", "data": [...] } — без limits
 */
export function unwrap(path, entity, body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    // Ошибки часто приходят простым текстом, и это самый частый «невалидный JSON»
    throw new SmartUpError(shorten(body) || 'Учётная система вернула пустой ответ', { path });
  }

  /*
   * Отказ приезжает ВАЛИДНЫМ JSON-ом вида {error_code, message}, причём
   * иногда с кодом 200. Без этой проверки нужного ключа в объекте просто
   * нет, список выходит пустым — и ответ читается как «данных нет».
   */
  if (typeof json?.error_code === 'string') {
    throw new SmartUpError(`${json.error_code} ${json.message ?? ''}`.trim(), { path });
  }

  const isV2 = path.includes('/api/v2/');
  const items = (isV2 ? (json.data ?? json[entity]) : json[entity]) ?? [];
  const limits = json.limits
    ? {
        limit: num(json.limits.limit_quant),
        left: num(json.limits.left_limit_quant),
        requested: num(json.limits.request_quant),
        objects: num(json.limits.object_count),
      }
    : null;

  return { items: Array.isArray(items) ? items : [], limits, json };
}

function num(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

function shorten(text, max = 400) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/* ── Вызов ─────────────────────────────────────────────────── */

/**
 * Один запрос к SmartUp. Возвращает разобранные строки, лимиты сервера и
 * то, сколько вызовов коннектор потратил сегодня сам.
 */
export async function call(name, body = {}, cfg = readConfig()) {
  const ep = EP[name];
  if (!ep) throw new SmartUpError(`Неизвестный метод «${name}»`);
  return rawCall(ep.path, ep.entity, body, cfg, ep.budget);
}

export async function rawCall(path, entity, body, cfg, budget = 'docs') {
  const usage = readUsage();
  if (usage.calls >= cfg.dailyBudget) {
    throw new SmartUpError(
      `Дневной предохранитель сработал: коннектор уже сделал ${usage.calls} запросов из ${cfg.dailyBudget}. ` +
        'Лимиты SmartUp общие с боевой работой — увеличьте предел в настройках расширения, если это осознанно.',
    );
  }

  // filial_code подставляем из настроек: без него сервер обслуживает запрос
  // по филиалу «по умолчанию», а какой он — знает только учётная система
  const payload = { ...body };
  if (cfg.filial && payload.filial_code === undefined && !isWritePath(path)) payload.filial_code = cfg.filial;

  // Проверку делаем ПОСЛЕ подстановки филиала: иначе чтение с филиалом из
  // настроек выглядело бы как запрос без филиала
  assertAllowed(path, cfg, payload);

  const auth = 'Basic ' + Buffer.from(`${cfg.login}:${cfg.password}`).toString('base64');
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method: 'POST', // да, и для чтения тоже: у API нет GET-ов
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new SmartUpError(
      e?.name === 'TimeoutError'
        ? `Учётная система не ответила за ${TIMEOUT_MS / 1000} секунд`
        : `Не достучались до учётной системы: ${e?.message ?? e}`,
      { path },
    );
  }

  const text = await res.text();
  const spent = bumpUsage(path);

  if (res.status === 401 || res.status === 403) {
    throw new SmartUpError(
      'Учётная система не приняла логин и пароль. Проверьте их в Настройках → Расширения → SmartUp.',
      { path, status: res.status },
    );
  }
  if (!res.ok) throw new SmartUpError(shorten(text) || `Учётная система ответила кодом ${res.status}`, { path, status: res.status });

  const parsed = unwrap(path, entity, text);
  return { ...parsed, path, budget, spentToday: spent.calls, dailyBudget: cfg.dailyBudget };
}

/* ── Кэш справочников ──────────────────────────────────────── */

const CACHE_DIR = join(homedir(), '.smartup-connector', 'cache');

/** Сколько живёт справочник. Номенклатура и склады за полдня не меняются */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Тот же вызов, но с кэшем на диске.
 *
 * Нужен ровно там, где справочник читается ради названий: остаток приезжает
 * с кодом товара `1,76008109` и без единого слова, и чтобы показать человеку
 * «Хлеб», номенклатуру приходится тянуть рядом. Без кэша каждый вопрос про
 * склад стоил бы двух вызовов из сотни, отпущенной на сутки.
 */
export async function cachedCall(name, body = {}, cfg = readConfig(), ttlMs = CACHE_TTL_MS) {
  const key = createHash('sha1').update(`${name}:${JSON.stringify(body)}:${cfg.filial}`).digest('hex').slice(0, 16);
  const file = join(CACHE_DIR, `${name}-${key}.json`);

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() - raw.at < ttlMs) return { ...raw.res, fromCache: true, cachedAt: new Date(raw.at).toISOString() };
  } catch {
    // Кэша нет или он испорчен — просто сходим на сервер
  }

  const res = await call(name, body, cfg);
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ at: Date.now(), res: { items: res.items, limits: res.limits, path: res.path, spentToday: res.spentToday, dailyBudget: res.dailyBudget } }));
  } catch {
    // Не записали — потеряем только скорость
  }
  return { ...res, fromCache: false };
}
