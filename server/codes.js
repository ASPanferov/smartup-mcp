import { call, toSmartUpDate } from './smartup.js';

/**
 * Какие коды нужны, чтобы заказ приняли, и какие из них рабочие.
 *
 * Проблема, ради которой существует этот файл. Чтобы создать заказ, SmartUp
 * требует коды, которых человек не знает и найти не может: рабочая зона,
 * штат менеджера, тип цены, склад, робот. Справочника штата в API НЕТ вовсе
 * (`staff$export` отвечает 404), а коды в карточке клиента могут указывать на
 * зону, за которой не закреплён ни один сотрудник.
 *
 * Хуже того, отказ приходит с чужим именем: заказ без `room_code` учётная
 * система отклоняет словами «Штат не найден. Код штата =», потому что штат она
 * выводит ИЗ ЗОНЫ и, не найдя зоны, сообщает о пустом штате. Человек идёт
 * искать менеджера, а не хватает зоны — и так по кругу, пока не кончится
 * суточный лимит.
 *
 * Решение: не спрашивать коды у человека, а взять их из заказов, которые уже
 * прошли. Такие коды доказали свою работоспособность самим фактом того, что
 * документ существует.
 */

/** Отменённый заказ ничего не доказывает: его могли отклонить как раз из-за кодов */
const CANCELLED = 'C';

/** За сколько дней смотреть назад. Дальше коды устаревают вместе с штатным расписанием */
const WINDOW_DAYS = 60;

/** Коды живут в памяти процесса: за один разговор их спрашивают по многу раз */
let cache = null;
const CACHE_TTL_MS = 30 * 60 * 1000;

/** Самое частое значение поля среди заказов, с числом подтверждений */
function commonest(rows, get) {
  const tally = new Map();
  for (const r of rows) {
    const v = get(r);
    if (v === null || v === undefined || v === '') continue;
    tally.set(String(v), (tally.get(String(v)) ?? 0) + 1);
  }
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? { value: best[0], orders: best[1], variants: tally.size } : null;
}

async function recentOrders(filial) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS && cache.filial === filial) return cache.rows;
  const res = await call('orderExport', {
    begin_deal_date: toSmartUpDate(`-${WINDOW_DAYS}d`),
    end_deal_date: toSmartUpDate(''),
    ...(filial ? { filial_code: filial } : {}),
  });
  const rows = res.items.filter((o) => String(o.status ?? '') !== CANCELLED);
  cache = { at: Date.now(), filial, rows };
  return rows;
}

export function forgetCodes() {
  cache = null;
}

/**
 * Коды, с которыми заказ примут.
 *
 * Сначала смотрим на заказы ЭТОГО клиента: у сетевого клиента своя зона и
 * свой менеджер, и общий по филиалу код увёл бы заказ в чужую зону. Если по
 * клиенту заказов нет — берём самое частое по филиалу: это лучше, чем ничего,
 * и честно помечается в ответе как «из практики филиала».
 */
export async function learnCodes(filial, personCode = null) {
  const all = await recentOrders(filial);
  const mine = personCode ? all.filter((o) => String(o.person_code ?? '') === String(personCode)) : [];
  const base = mine.length > 0 ? mine : all;
  const source = mine.length > 0 ? 'заказы этого клиента' : 'практика филиала';

  const lines = base.flatMap((o) => o.order_products ?? []);

  return {
    source,
    ordersLookedAt: base.length,
    clientOrders: mine.length,
    codes: {
      room_code: commonest(base, (o) => o.room_code),
      sales_manager_code: commonest(base, (o) => o.sales_manager_code),
      robot_code: commonest(base, (o) => o.robot_code),
      payment_type_code: commonest(base, (o) => o.payment_type_code),
      currency_code: commonest(base, (o) => o.currency_code),
      price_type_code: commonest(lines, (p) => p.price_type_code),
      warehouse_code: commonest(lines, (p) => p.warehouse_code),
    },
    managers: managersFrom(all),
  };
}

/**
 * Менеджеры, которых учётная система принимает.
 *
 * Отдельного справочника нет, поэтому собираем из заказов: код, имя и то,
 * в каких зонах человек работает. Зона важнее имени — именно по ней SmartUp
 * ищет штат при создании документа.
 */
export function managersFrom(rows) {
  const acc = new Map();
  for (const o of rows) {
    const code = o.sales_manager_code;
    if (!code) continue;
    const key = String(code);
    if (!acc.has(key)) acc.set(key, { code: key, name: o.sales_manager_name ?? null, orders: 0, rooms: new Set() });
    const m = acc.get(key);
    m.orders += 1;
    if (o.room_code) m.rooms.add(String(o.room_code));
    if (!m.name && o.sales_manager_name) m.name = o.sales_manager_name;
  }
  return [...acc.values()]
    .sort((a, b) => b.orders - a.orders)
    .map((m) => ({ code: m.code, имя: m.name, заказов: m.orders, зоны: [...m.rooms] }));
}

/** Значение кода или null — коротко, без обёртки со статистикой */
export function valueOf(learned, field) {
  return learned.codes[field]?.value ?? null;
}
