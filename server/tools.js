import { EP, SmartUpError, cachedCall, call, rawCall, readConfig, readUsage, toSmartUpDate } from './smartup.js';
import { DATE_HINT, DEFAULT_LIMIT, limitOf, matches, pick, reply, summaryOf } from './format.js';
import { REPORT_TOOLS } from './reports.js';
import { WRITE_TOOLS } from './write.js';

/**
 * Инструменты коннектора.
 *
 * Общее правило вывода: не вываливать сырой ответ. SmartUp отдаёт документы с
 * полусотней полей, из которых человеку нужны пять, а модели в контекст
 * попадает всё. Поэтому каждый инструмент отдаёт свод (сколько нашлось, что
 * с лимитами) и подрезанные строки — а `fields` позволяет попросить остальное
 * точечно.
 */

/* ── Инструменты чтения ────────────────────────────────────── */

const READ_TOOLS = [
  {
    name: 'smartup_orders',
    title: 'Заказы',
    description:
      'Заказы (сделки) за период с составом и статусом. Отвечает на «что заказали», «в каком статусе заказ», ' +
      '«сколько отгрузили клиенту за неделю». ' + DATE_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        begin: { type: 'string', description: 'Начало периода. По умолчанию 7 дней назад' },
        end: { type: 'string', description: 'Конец периода. По умолчанию сегодня' },
        person_code: { type: 'string', description: 'Код контрагента — оставит только его заказы' },
        query: { type: 'string', description: 'Поиск по названию клиента, номеру или коду сделки' },
        status: { type: 'string', description: 'Статус в учётной системе, например B#N или A' },
        with_items: { type: 'boolean', description: 'Показать состав заказа построчно. По умолчанию нет' },
        limit: { type: 'number', description: `Сколько заказов показать, по умолчанию ${DEFAULT_LIMIT}` },
        filial_code: { type: 'string', description: 'Филиал, если нужен не тот, что в настройках' },
      },
    },
    async run(input) {
      const res = await call('orderExport', {
        begin_deal_date: toSmartUpDate(input.begin, -7),
        end_deal_date: toSmartUpDate(input.end, 0),
        ...(input.filial_code ? { filial_code: input.filial_code } : {}),
      });

      let rows = res.items;
      if (input.person_code) rows = rows.filter((r) => String(r.person_code ?? '') === String(input.person_code));
      if (input.status) rows = rows.filter((r) => String(r.status ?? '').toUpperCase() === String(input.status).toUpperCase());
      rows = rows.filter((r) => matches(r, input.query, ['person_name', 'deal_id', 'external_id', 'person_code', 'note', 'deal_note']));

      const shown = rows.slice(0, limitOf(input)).map((r) => ({
        deal_id: r.deal_id,
        внешний_номер: r.external_id ?? null,
        оформлен: r.deal_time ?? null,
        доставка: r.delivery_date ?? null,
        клиент: r.person_name ?? r.person_code,
        код_клиента: r.person_code,
        инн: r.person_tin ?? null,
        статус: r.status,
        сумма: r.total_amount ?? null,
        самовывоз: r.self_shipment === 'Y' ? 'да' : undefined,
        адрес: r.delivery_address_short ?? null,
        примечание: r.note ?? r.deal_note ?? null,
        позиций: (r.order_products ?? []).length,
        ...(input.with_items
          ? {
              состав: (r.order_products ?? []).map((p) => ({
                товар: p.product_name ?? p.product_code,
                код: p.product_code,
                количество: p.order_quant,
                цена: p.product_price,
                // Суммы по строке в ответе нет — считаем сами, иначе состав
                // молчит о том, из чего сложился итог документа
                сумма: Number(p.order_quant ?? 0) * Number(p.product_price ?? 0) || null,
              })),
            }
          : {}),
      }));

      return reply(summaryOf(res, shown.length, {
        период: `${toSmartUpDate(input.begin, -7)} — ${toSmartUpDate(input.end, 0)}`,
        после_фильтров: rows.length,
      }), shown);
    },
  },

  {
    name: 'smartup_stock',
    title: 'Остатки на складах',
    description:
      'Свободные остатки по товарам и складам на дату. Отвечает на «сколько осталось», «есть ли товар на складе».',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Дата остатка. По умолчанию сегодня' },
        query: { type: 'string', description: 'Поиск по названию или коду товара' },
        warehouse: { type: 'string', description: 'Код или название склада' },
        only_positive: { type: 'boolean', description: 'Только то, что есть в наличии. По умолчанию да' },
        no_names: { type: 'boolean', description: 'Не подтягивать названия товаров и складов — быстрее, но в ответе будут только коды' },
        limit: { type: 'number', description: `Сколько строк показать, по умолчанию ${DEFAULT_LIMIT}` },
        filial_code: { type: 'string' },
      },
    },
    async run(input) {
      const date = toSmartUpDate(input.date, 0);
      const res = await call('balance', {
        begin_date: date,
        end_date: date,
        // Свободный остаток: то, что не зарезервировано под собранные заказы.
        // Значение — односимвольный код: F свободно, B забронировано, T в пути
        product_conditions: ['F'],
        ...(input.filial_code ? { filial_code: input.filial_code } : {}),
      });

      /*
       * Остаток приезжает БЕЗ НАЗВАНИЯ: только код товара вида «1,76008109» и
       * код склада. Поэтому рядом читаем два справочника — из кэша, он живёт
       * полдня, — и подставляем слова. Без них ответ выглядит как таблица
       * цифр, по которой ничего не спросишь.
       */
      const names = new Map();
      const rooms = new Map();
      if (input.no_names !== true) {
        const inv = await cachedCall('inventory', {});
        for (const p of inv.items) names.set(String(p.code), p);
        const rm = await cachedCall('room', {});
        for (const r of rm.items) rooms.set(String(r.room_code), r.room_name);
      }

      const named = res.items.map((r) => {
        const p = names.get(String(r.product_code));
        return {
          ...r,
          _name: p?.name ?? p?.short_name ?? null,
          _room: rooms.get(String(r.warehouse_code)) ?? null,
          _box: p?.box_quant ?? null,
        };
      });

      let rows = named.filter((r) => matches(r, input.query, ['_name', 'product_code']));
      if (input.warehouse) rows = rows.filter((r) => matches(r, input.warehouse, ['_room', 'warehouse_code']));
      if (input.only_positive !== false) rows = rows.filter((r) => Number(r.quantity ?? 0) > 0);

      /*
       * Одна и та же позиция приходит несколькими строками — по партиям
       * (batch_number) и складам. Человека интересует «сколько всего», а не
       * бухгалтерия партий, поэтому складываем по товару и складу.
       */
      const merged = new Map();
      for (const r of rows) {
        const key = `${r.product_code}__${r.warehouse_code}`;
        const hit = merged.get(key);
        if (hit) hit.остаток += Number(r.quantity ?? 0);
        else
          merged.set(key, {
            товар: r._name ?? `код ${r.product_code}`,
            код: r.product_code,
            склад: r._room ?? r.warehouse_code,
            остаток: Number(r.quantity ?? 0),
            в_коробе: r._box ?? null,
          });
      }
      const all = [...merged.values()].sort((a, b) => b.остаток - a.остаток);

      return reply(
        summaryOf(res, Math.min(all.length, limitOf(input)), {
          дата: date,
          строк_с_партиями: rows.length,
          позиций_после_слияния: all.length,
        }),
        all.slice(0, limitOf(input)),
      );
    },
  },

  {
    name: 'smartup_products',
    title: 'Номенклатура',
    description: 'Справочник товаров: название, код, артикул, упаковка, бренд. Отвечает на «есть ли такой товар», «какой у него код».',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поиск по названию, коду или артикулу' },
        limit: { type: 'number', description: `Сколько показать, по умолчанию ${DEFAULT_LIMIT}` },
        fields: { type: 'array', items: { type: 'string' }, description: 'Какие поля вернуть целиком, если нужны нестандартные' },
        filial_code: { type: 'string' },
      },
    },
    async run(input) {
      const res = await cachedCall('inventory', input.filial_code ? { filial_code: input.filial_code } : {});
      const rows = res.items.filter((r) => matches(r, input.query, ['name', 'short_name', 'code', 'article_code', 'barcodes']));
      const shown = rows.slice(0, limitOf(input)).map((r) =>
        input.fields?.length
          ? pick(r, input.fields)
          : {
              товар: r.name ?? r.short_name,
              код: r.code,
              артикул: r.article_code ?? null,
              в_коробе: r.box_quant ?? null,
              вес_нетто: r.weight_netto ?? null,
              // A — позиция в работе. Всё остальное снято с продажи
              состояние: r.state === 'A' ? 'активна' : r.state,
            },
      );
      return reply(summaryOf(res, shown.length, { после_поиска: rows.length }), shown);
    },
  },

  {
    name: 'smartup_prices',
    title: 'Цены',
    description: 'Цены товаров по типам прайса. Отвечает на «почём отгружаем», «какая цена у клиента такого-то типа».',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поиск по названию или коду товара' },
        price_type_code: { type: 'string', description: 'Код типа цены. Список — в smartup_reference(price_type)' },
        limit: { type: 'number' },
        filial_code: { type: 'string' },
      },
    },
    async run(input) {
      const res = await call('productPrice', {
        ...(input.price_type_code ? { price_type_code: input.price_type_code } : {}),
        ...(input.filial_code ? { filial_code: input.filial_code } : {}),
      });
      const rows = res.items.filter((r) => matches(r, input.query, ['inventory_name', 'inventory_code', 'product_name', 'product_code']));
      const shown = rows.slice(0, limitOf(input)).map((r) => ({
        товар: r.inventory_name ?? r.product_name,
        код: r.inventory_code ?? r.product_code,
        цена: r.price ?? r.amount ?? null,
        валюта: r.currency_code ?? r.currency ?? null,
        тип_цены: r.price_type_name ?? r.price_type_code ?? null,
        действует_с: r.begin_date ?? null,
      }));
      return reply(summaryOf(res, shown.length, { после_поиска: rows.length }), shown);
    },
  },

  {
    name: 'smartup_contractors',
    title: 'Контрагенты и точки',
    description:
      'Юрлица из справочника: клиенты и их торговые точки. Отвечает на «есть ли такой клиент», «какой у него ИНН и код», ' +
      '«какие у него точки». Точка — это юрлицо с родительской карточкой, отдельной сущности «точка» в API нет.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поиск по названию, ИНН или коду' },
        parent_code: { type: 'string', description: 'Показать точки этого контрагента' },
        limit: { type: 'number' },
        filial_code: { type: 'string' },
      },
    },
    async run(input) {
      const res = await call('legalPerson', input.filial_code ? { filial_code: input.filial_code } : {});
      let rows = res.items.filter((r) => matches(r, input.query, ['person_name', 'name', 'person_code', 'code', 'tin', 'inn']));
      if (input.parent_code) rows = rows.filter((r) => String(r.parent_person_code ?? '') === String(input.parent_code));
      const shown = rows.slice(0, limitOf(input)).map((r) => ({
        название: r.person_name ?? r.name,
        код: r.person_code ?? r.code,
        инн: r.tin ?? r.inn ?? null,
        родитель: r.parent_person_code ?? null,
        адрес: r.address ?? null,
        телефон: r.phone ?? null,
      }));
      return reply(summaryOf(res, shown.length, { после_поиска: rows.length }), shown);
    },
  },

  {
    name: 'smartup_payments',
    title: 'Оплаты',
    description: 'Приходы денег за период. Отвечает на «платил ли клиент», «сколько пришло за неделю». ' + DATE_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        begin: { type: 'string', description: 'Начало периода. По умолчанию 7 дней назад' },
        end: { type: 'string', description: 'Конец периода. По умолчанию сегодня' },
        query: { type: 'string', description: 'Поиск по клиенту или номеру документа' },
        limit: { type: 'number' },
        filial_code: { type: 'string' },
      },
    },
    async run(input) {
      const res = await call('cashin', {
        begin_cashin_date: toSmartUpDate(input.begin, -7),
        end_cashin_date: toSmartUpDate(input.end, 0),
        ...(input.filial_code ? { filial_code: input.filial_code } : {}),
      });
      const rows = res.items.filter((r) => matches(r, input.query, ['client_name', 'client_code', 'cashin_id', 'note']));
      const shown = rows.slice(0, limitOf(input)).map((r) => ({
        документ: r.cashin_id ?? r.id,
        дата: r.cashin_date,
        клиент: r.client_name ?? r.client_code,
        код_клиента: r.client_code,
        сумма: r.amount ?? r.total_amount ?? null,
        валюта: r.currency_code ?? null,
        проведён: r.status ?? null,
      }));
      return reply(summaryOf(res, shown.length, {
        период: `${toSmartUpDate(input.begin, -7)} — ${toSmartUpDate(input.end, 0)}`,
        после_поиска: rows.length,
      }), shown);
    },
  },

  {
    name: 'smartup_returns',
    title: 'Возвраты',
    description: 'Возвраты товара за период. Отвечает на «что вернули», «сколько возвратов у клиента». ' + DATE_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        begin: { type: 'string', description: 'Начало периода. По умолчанию 30 дней назад' },
        end: { type: 'string', description: 'Конец периода. По умолчанию сегодня' },
        query: { type: 'string', description: 'Поиск по клиенту или номеру' },
        limit: { type: 'number' },
        filial_code: { type: 'string' },
      },
    },
    async run(input) {
      const res = await call('returnExport', {
        begin_return_date: toSmartUpDate(input.begin, -30),
        end_return_date: toSmartUpDate(input.end, 0),
        ...(input.filial_code ? { filial_code: input.filial_code } : {}),
      });
      const rows = res.items.filter((r) => matches(r, input.query, ['person_name', 'person_code', 'return_id', 'note']));
      const shown = rows.slice(0, limitOf(input)).map((r) => ({
        документ: r.return_id ?? r.id,
        дата: r.return_date,
        клиент: r.person_name ?? r.person_code,
        сумма: r.total_amount ?? r.amount ?? null,
        причина: r.note ?? r.reason ?? null,
      }));
      return reply(summaryOf(res, shown.length, {
        период: `${toSmartUpDate(input.begin, -30)} — ${toSmartUpDate(input.end, 0)}`,
        после_поиска: rows.length,
      }), shown);
    },
  },

  {
    name: 'smartup_reference',
    title: 'Справочники',
    description:
      'Остальные справочники: склады (room), группы товаров (product_group), производители (producer), ' +
      'типы цен (price_type), договоры (contract), физлица (natural_person), рейсы (logistics).',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: ['room', 'productGroup', 'producer', 'priceType', 'contract', 'naturalPerson', 'logistics'],
          description: 'Какой справочник выгрузить',
        },
        query: { type: 'string', description: 'Поиск по любому текстовому полю' },
        limit: { type: 'number' },
        filial_code: { type: 'string' },
      },
      required: ['name'],
    },
    async run(input) {
      const res = await call(input.name, input.filial_code ? { filial_code: input.filial_code } : {});
      const rows = input.query
        ? res.items.filter((r) => JSON.stringify(r).toLowerCase().includes(String(input.query).toLowerCase()))
        : res.items;
      return reply(summaryOf(res, Math.min(rows.length, limitOf(input)), { справочник: input.name }), rows.slice(0, limitOf(input)));
    },
  },

  {
    name: 'smartup_export',
    title: 'Произвольная выгрузка',
    description:
      'Прямой вызов любого метода `$export`, когда готового инструмента не хватает. ' +
      'Записывающие методы ($import, $change_status, $attach_data) запрещены — коннектор только читает.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь метода, например /b/trade/txs/tdeal/order$export' },
        entity: { type: 'string', description: 'Корневой ключ ответа. Если не указан — берём из пути' },
        body: { type: 'object', description: 'Тело запроса как есть. filial_code подставится из настроек' },
        limit: { type: 'number' },
      },
      required: ['path'],
    },
    async run(input) {
      const path = String(input.path).trim();
      const guessed = input.entity || path.split('/').pop().replace('$export', '');
      const res = await rawCall(path, guessed, input.body ?? {}, readConfig());
      return reply(summaryOf(res, Math.min(res.items.length, limitOf(input)), { метод: path, ключ_ответа: guessed }),
        res.items.slice(0, limitOf(input)));
    },
  },

  {
    name: 'smartup_usage',
    title: 'Сколько запросов потрачено',
    description:
      'Сколько запросов коннектор сделал за сегодня и какой у него предел. Лимиты SmartUp общие с боевой работой, ' +
      'поэтому смотреть сюда стоит перед большими выгрузками.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const cfg = readConfig();
      const usage = readUsage();
      return reply(
        {
          дата: usage.date,
          запросов_сегодня: usage.calls,
          предел_коннектора: cfg.dailyBudget,
          филиал_по_умолчанию: cfg.filial || 'не задан',
          адрес: cfg.baseUrl,
          режим: 'только чтение',
        },
        usage.byPath,
      );
    },
  },
];

/**
 * Полный набор: чтение, сводки, запись.
 *
 * Инструменты записи в списке ЕСТЬ всегда, даже когда режим выключен: иначе
 * на вопрос «заведи заказ» модель отвечала бы «не умею» вместо честного «это
 * запрещено настройками, включите галочку». Отказ выдаёт проверка внутри.
 */
export const TOOLS = [...READ_TOOLS, ...REPORT_TOOLS, ...WRITE_TOOLS];

/** Найти и выполнить. Ошибку отдаём текстом: модель должна её прочитать, а не упасть */
export async function runTool(name, input = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new SmartUpError(`Нет такого инструмента: ${name}`);
  try {
    return await tool.run(input ?? {});
  } catch (e) {
    const text = e instanceof SmartUpError ? e.message : `Сбой инструмента: ${e?.message ?? e}`;
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

export { EP };
