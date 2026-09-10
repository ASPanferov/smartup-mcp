import { call, toSmartUpDate } from './smartup.js';
import { DATE_HINT, limitOf, money, num, reply, summaryOf } from './format.js';

/**
 * Сводные инструменты: то, чего в API нет готовым ответом.
 *
 * SmartUp отдаёт документы, а спрашивают у него состояния: «сколько должен
 * клиент», «что лучше продавалось». Ответ на такой вопрос — это две-три
 * выгрузки и арифметика поверх них. Считать её в разговоре руками означает
 * тратить лимиты на то, что должно быть одним вызовом.
 */

/** Заказ ещё не отгружен: деньги за него заняты, но долгом не стали */
const IN_PROGRESS = new Set(['D', 'B#N', 'B#E', 'B#W', 'B#S']);

/** Отменённый заказ не считается ни отгрузкой, ни обязательством */
const CANCELLED = 'C';

export const REPORT_TOOLS = [
  {
    name: 'smartup_debt',
    title: 'Долги и взаиморасчёты',
    description:
      'Сколько клиент должен: отгрузки минус оплаты минус возвраты за период. Отвечает на «кто сколько должен», ' +
      '«есть ли долг у клиента», «кому пора звонить». Считается из заказов, оплат и возвратов — трёх выгрузок. ' +
      DATE_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        begin: { type: 'string', description: 'Начало периода. По умолчанию 90 дней назад' },
        end: { type: 'string', description: 'Конец периода. По умолчанию сегодня' },
        query: { type: 'string', description: 'Только клиенты, чьё название или код содержит эту строку' },
        person_code: { type: 'string', description: 'Только этот контрагент' },
        only_debtors: { type: 'boolean', description: 'Оставить тех, у кого долг больше нуля. По умолчанию да' },
        limit: { type: 'number', description: 'Сколько клиентов показать' },
        filial_code: { type: 'string' },
      },
    },
    async run(input) {
      const begin = toSmartUpDate(input.begin, -90);
      const end = toSmartUpDate(input.end, 0);
      const filial = input.filial_code ? { filial_code: input.filial_code } : {};

      const orders = await call('orderExport', { begin_deal_date: begin, end_deal_date: end, ...filial });
      const payments = await call('cashin', { begin_cashin_date: begin, end_cashin_date: end, ...filial });
      const returns = await call('returnExport', { begin_return_date: begin, end_return_date: end, ...filial });

      /*
       * Считаем по коду контрагента, а не по названию: у сетевого клиента
       * точки называются похоже, и по имени долги двух разных юрлиц слиплись
       * бы в одну строку.
       */
      const acc = new Map();
      const touch = (code, name) => {
        const key = String(code ?? '—');
        if (!acc.has(key))
          acc.set(key, { клиент: name ?? key, код: key, отгружено: 0, в_работе: 0, оплачено: 0, возвраты: 0 });
        const row = acc.get(key);
        if (name && row.клиент === key) row.клиент = name;
        return row;
      };

      for (const o of orders.items) {
        if (String(o.status ?? '') === CANCELLED) continue;
        const row = touch(o.person_code, o.person_name);
        // Незакрытый заказ — ещё не долг: товар не уехал. Но деньги под него
        // уже заняты, и менеджеру это видеть надо отдельной цифрой
        if (IN_PROGRESS.has(String(o.status ?? ''))) row.в_работе += num(o.total_amount);
        else row.отгружено += num(o.total_amount);
      }
      for (const p of payments.items) touch(p.client_code, p.client_name).оплачено += num(p.amount ?? p.total_amount);
      /*
       * Возврат приезжает ОТРИЦАТЕЛЬНОЙ суммой: в учёте это движение вспять.
       * Берём модуль и вычитаем сами — иначе минус на минус давал плюс, и
       * возврат увеличивал долг вместо того, чтобы его гасить.
       */
      for (const r of returns.items) touch(r.person_code, r.person_name).возвраты += Math.abs(num(r.total_amount ?? r.amount));

      let rows = [...acc.values()].map((r) => ({
        ...r,
        долг: r.отгружено - r.оплачено - r.возвраты,
      }));

      if (input.person_code) rows = rows.filter((r) => r.код === String(input.person_code));
      if (input.query) {
        const q = String(input.query).toLowerCase();
        rows = rows.filter((r) => `${r.клиент} ${r.код}`.toLowerCase().includes(q));
      }
      if (input.only_debtors !== false) rows = rows.filter((r) => r.долг > 0);
      rows.sort((a, b) => b.долг - a.долг);

      const shown = rows.slice(0, limitOf(input)).map((r) => ({
        клиент: r.клиент,
        код: r.код,
        долг: money(r.долг),
        отгружено: money(r.отгружено),
        оплачено: money(r.оплачено),
        возвраты: r.возвраты ? money(r.возвраты) : undefined,
        заказы_в_работе: r.в_работе ? money(r.в_работе) : undefined,
      }));

      return reply(
        summaryOf(orders, shown.length, {
          период: `${begin} — ${end}`,
          клиентов_с_движением: acc.size,
          всего_долг: money(rows.reduce((s, r) => s + Math.max(0, r.долг), 0)),
          источники: `заказов ${orders.items.length}, оплат ${payments.items.length}, возвратов ${returns.items.length}`,
          как_считано: 'отгружено − оплачено − возвраты; заказы в незакрытых статусах в долг не входят',
        }),
        shown,
      );
    },
  },

  {
    name: 'smartup_sales',
    title: 'Отчёт по продажам',
    description:
      'Свод продаж за период: по клиентам, по товарам или по дням. Отвечает на «что продавалось лучше всего», ' +
      '«сколько отгрузили за месяц», «кто крупнейший клиент». ' + DATE_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        begin: { type: 'string', description: 'Начало периода. По умолчанию 30 дней назад' },
        end: { type: 'string', description: 'Конец периода. По умолчанию сегодня' },
        group_by: {
          type: 'string',
          enum: ['client', 'product', 'day', 'status'],
          description: 'Разрез: по клиентам, товарам, дням или статусам. По умолчанию по клиентам',
        },
        query: { type: 'string', description: 'Только заказы, где встречается эта строка' },
        limit: { type: 'number', description: 'Сколько строк показать' },
        filial_code: { type: 'string' },
      },
    },
    async run(input) {
      const begin = toSmartUpDate(input.begin, -30);
      const end = toSmartUpDate(input.end, 0);
      const res = await call('orderExport', {
        begin_deal_date: begin,
        end_deal_date: end,
        ...(input.filial_code ? { filial_code: input.filial_code } : {}),
      });

      const alive = res.items.filter((o) => String(o.status ?? '') !== CANCELLED);
      const by = input.group_by ?? 'client';
      const acc = new Map();
      const add = (key, label, amount, qty = 0) => {
        if (!acc.has(key)) acc.set(key, { ключ: label, сумма: 0, заказов: 0, количество: 0 });
        const row = acc.get(key);
        row.сумма += amount;
        row.заказов += 1;
        row.количество += qty;
      };

      for (const o of alive) {
        if (input.query && !JSON.stringify(o).toLowerCase().includes(String(input.query).toLowerCase())) continue;
        if (by === 'product') {
          // По товарам считать можно только построчно: сумма шапки ничего не
          // говорит о том, что именно продавалось
          for (const p of o.order_products ?? []) {
            add(
              String(p.product_code),
              p.product_name ?? p.product_code,
              num(p.order_quant) * num(p.product_price),
              num(p.order_quant),
            );
          }
          continue;
        }
        if (by === 'day') add(String(o.delivery_date ?? o.deal_time ?? '—').slice(0, 10), String(o.delivery_date ?? o.deal_time ?? '—').slice(0, 10), num(o.total_amount));
        else if (by === 'status') add(String(o.status ?? '—'), String(o.status ?? '—'), num(o.total_amount));
        else add(String(o.person_code ?? '—'), o.person_name ?? o.person_code ?? '—', num(o.total_amount));
      }

      const rows = [...acc.values()].sort((a, b) => b.сумма - a.сумма);
      const total = rows.reduce((s, r) => s + r.сумма, 0);
      const shown = rows.slice(0, limitOf(input)).map((r) => ({
        [by === 'product' ? 'товар' : by === 'day' ? 'дата' : by === 'status' ? 'статус' : 'клиент']: r.ключ,
        сумма: money(r.сумма),
        доля: total ? `${((r.сумма / total) * 100).toFixed(1)}%` : '—',
        заказов: r.заказов,
        количество: r.количество || undefined,
      }));

      return reply(
        summaryOf(res, shown.length, {
          период: `${begin} — ${end}`,
          разрез: by,
          заказов_учтено: alive.length,
          отменённых_пропущено: res.items.length - alive.length,
          итого: money(total),
        }),
        shown,
      );
    },
  },

  {
    name: 'smartup_order',
    title: 'Один заказ',
    description:
      'Один заказ целиком по номеру сделки или внешнему номеру: шапка, состав, статус. ' +
      'Отвечает на «что в заказе 283581248», «почему заказ не отгружен».',
    inputSchema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string', description: 'Номер сделки в учётной системе' },
        external_id: { type: 'string', description: 'Внешний номер, под которым заказ создавала внешняя система' },
        begin: { type: 'string', description: 'С какой даты искать. По умолчанию 60 дней назад' },
        end: { type: 'string', description: 'По какую дату искать. По умолчанию сегодня' },
        filial_code: { type: 'string' },
      },
    },
    async run(input) {
      if (!input.deal_id && !input.external_id) {
        return reply({ ошибка: 'Назовите deal_id или external_id' }, []);
      }
      /*
       * Метода «дай один заказ» в API нет: заказы отдаются только окном дат.
       * Поэтому берём окно и фильтруем — и по умолчанию берём широкое, иначе
       * ответ «не нашли» означал бы всего лишь «искали не там».
       */
      const begin = toSmartUpDate(input.begin, -60);
      const end = toSmartUpDate(input.end, 0);
      const res = await call('orderExport', {
        begin_deal_date: begin,
        end_deal_date: end,
        ...(input.filial_code ? { filial_code: input.filial_code } : {}),
      });

      const hit = res.items.find(
        (o) =>
          (input.deal_id && String(o.deal_id) === String(input.deal_id)) ||
          (input.external_id && String(o.external_id) === String(input.external_id)),
      );

      if (!hit) {
        return reply(
          {
            найдено: 0,
            период: `${begin} — ${end}`,
            подсказка: 'Заказа нет в этом окне дат. Расширьте период параметрами begin и end.',
          },
          [],
        );
      }

      const items = (hit.order_products ?? []).map((p) => ({
        товар: p.product_name ?? p.product_code,
        код: p.product_code,
        количество: p.order_quant,
        цена: money(p.product_price),
        сумма: money(num(p.order_quant) * num(p.product_price)),
        склад: p.warehouse_code ?? null,
      }));

      return reply(
        {
          deal_id: hit.deal_id,
          внешний_номер: hit.external_id ?? null,
          оформлен: hit.deal_time ?? null,
          доставка: hit.delivery_date ?? null,
          статус: hit.status,
          клиент: hit.person_name ?? hit.person_code,
          код_клиента: hit.person_code,
          инн: hit.person_tin ?? null,
          сумма: money(hit.total_amount),
          самовывоз: hit.self_shipment === 'Y' ? 'да' : 'нет',
          адрес: hit.delivery_address_full ?? hit.delivery_address_short ?? null,
          примечание: hit.note ?? hit.deal_note ?? null,
          менеджер: hit.sales_manager_name ?? null,
          позиций: items.length,
        },
        items,
      );
    },
  },
];
