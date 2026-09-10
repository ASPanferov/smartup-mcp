import { EP, SmartUpError, importResult, rawCall, readConfig, toSmartUpDate } from './smartup.js';
import { num, reply } from './format.js';

/**
 * Инструменты, которые МЕНЯЮТ учётную систему.
 *
 * Работают, только когда в настройках расширения включена галочка «Разрешить
 * изменение данных» и назван код филиала: проверку делает assertAllowed в
 * smartup.js, здесь её не дублируем.
 *
 * Три правила, общие для всего файла:
 *
 *  - у каждой записи есть свой ключ идемпотентности (`external_id`). Повтор
 *    того же запроса не создаёт второй документ, а обновляет прежний: сеть
 *    рвётся, а заказ, задвоенный в учёте, едет на склад дважды;
 *  - лишних полей не отправляем. Импорт SmartUp роняет ВЕСЬ документ из-за
 *    одного неизвестного ключа, а не отдельную строку;
 *  - ответ разбираем телом, а не кодом HTTP: отказ приходит с кодом 200 и
 *    лежит в errors[].message.
 */

/** Черновик. Склад его не соберёт, пока менеджер не проведёт документ */
const DRAFT = 'D';

/** Узбекский сум. В API валюта — числовой код строкой */
const CURRENCY_UZS = '860';

/** Обычный товар (не материал и не продукция собственного производства) */
const GOODS = 'G';

/** Ключ идемпотентности, если внешняя система его не назвала */
function generatedId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function write(name, body) {
  const ep = EP[name];
  const cfg = readConfig();
  const res = await rawCall(ep.path, ep.entity, body, cfg, ep.budget);
  return { successes: importResult(res.json), res };
}

export const WRITE_TOOLS = [
  {
    name: 'smartup_order_create',
    title: 'Создать заказ',
    description:
      'Заводит заказ в учётной системе. По умолчанию ЧЕРНОВИКОМ: склад его не соберёт, пока менеджер не проведёт ' +
      'документ. Требует включённого режима записи. Повторный вызов с тем же external_id обновляет тот же заказ, ' +
      'а не создаёт второй.',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        person_code: { type: 'string', description: 'Код контрагента — кому отгружаем. Найти можно в smartup_contractors' },
        products: {
          type: 'array',
          description: 'Строки заказа',
          items: {
            type: 'object',
            properties: {
              product_code: { type: 'string', description: 'Код товара из smartup_products' },
              quantity: { type: 'number', description: 'Количество в штуках' },
              price: { type: 'number', description: 'Цена за штуку' },
              price_type_code: { type: 'string', description: 'Тип прайса, если в системе их несколько' },
              warehouse_code: { type: 'string', description: 'Склад отгрузки, если он задан не по умолчанию' },
              inventory_kind: { type: 'string', description: 'Вид позиции: G товар, P продукция, M материал. По умолчанию G' },
            },
            required: ['product_code', 'quantity', 'price'],
          },
        },
        delivery_date: { type: 'string', description: 'Дата доставки. По умолчанию завтра' },
        status: { type: 'string', description: `Статус документа. По умолчанию ${DRAFT} — черновик` },
        external_id: { type: 'string', description: 'Свой номер заказа. Если не задан, будет сгенерирован' },
        note: { type: 'string', description: 'Примечание к заказу' },
        self_shipment: { type: 'boolean', description: 'Самовывоз. По умолчанию нет' },
        room_code: { type: 'string', description: 'Рабочая зона (код room)' },
        sales_manager_code: { type: 'string', description: 'Код менеджера продаж' },
        robot_code: { type: 'string', description: 'Код источника заказа, если он требуется в вашем контуре' },
        currency_code: { type: 'string', description: `Валюта числовым кодом. По умолчанию ${CURRENCY_UZS} — сум` },
        filial_code: { type: 'string', description: 'Филиал. По умолчанию тот, что в настройках' },
      },
      required: ['person_code', 'products'],
    },
    async run(input) {
      const cfg = readConfig();
      const filial = (input.filial_code ?? cfg.filial ?? '').trim();
      if (!Array.isArray(input.products) || input.products.length === 0) {
        throw new SmartUpError('В заказе нет ни одной строки');
      }

      const externalId = String(input.external_id ?? generatedId('mcp')).trim();
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const dealTime = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

      const header = {
        filial_code: filial,
        external_id: externalId,
        deal_time: dealTime,
        delivery_date: toSmartUpDate(input.delivery_date, 1),
        status: String(input.status ?? DRAFT),
        person_code: String(input.person_code),
        // Плательщик по умолчанию тот же, кому отгружаем: в рознице и HoReCa
        // это одно лицо, а сети приезжают с родительской карточкой отдельно
        owner_person_code: String(input.person_code),
        currency_code: String(input.currency_code ?? CURRENCY_UZS),
        self_shipment: input.self_shipment ? 'Y' : 'N',
        order_products: input.products.map((p, i) => {
          const item = {
            // Свой ключ у КАЖДОЙ строки — иначе повторный импорт задвоит
            // позиции внутри заказа
            external_id: `${externalId}-${i + 1}`,
            product_code: String(p.product_code),
            order_quant: String(num(p.quantity)),
            product_price: String(num(p.price)),
            inventory_kind: String(p.inventory_kind ?? GOODS),
          };
          if (p.price_type_code) item.price_type_code = String(p.price_type_code);
          if (p.warehouse_code) item.warehouse_code = String(p.warehouse_code);
          return item;
        }),
      };

      // Необязательные поля кладём, только когда они названы: лишний ключ
      // роняет весь документ
      if (input.room_code) header.room_code = String(input.room_code);
      if (input.sales_manager_code) header.sales_manager_code = String(input.sales_manager_code);
      if (input.robot_code) header.robot_code = String(input.robot_code);
      if (input.note) header.note = String(input.note);

      const { successes } = await write('orderImport', { order: [header] });
      const total = header.order_products.reduce((s, p) => s + num(p.order_quant) * num(p.product_price), 0);

      return reply(
        {
          результат: 'заказ принят учётной системой',
          deal_id: successes[0]?.deal_id ?? successes[0]?.id ?? null,
          внешний_номер: externalId,
          статус: header.status,
          статус_значит: header.status === DRAFT ? 'черновик — склад не соберёт, пока менеджер не проведёт' : 'проведён по указанному статусу',
          клиент: header.person_code,
          доставка: header.delivery_date,
          позиций: header.order_products.length,
          сумма: total.toLocaleString('ru-RU'),
          филиал: filial,
        },
        successes,
      );
    },
  },

  {
    name: 'smartup_order_status',
    title: 'Сменить статус заказа',
    description:
      'Меняет статус существующего заказа: провести, отменить, вернуть в работу. Требует включённого режима записи. ' +
      'Отмена необратима со стороны коннектора — вернуть заказ можно только в самой учётной системе.',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string', description: 'Номер сделки' },
        status: { type: 'string', description: 'Новый статус: C — отменён, A — архив, B#N и далее — этапы обработки' },
        filial_code: { type: 'string' },
      },
      required: ['deal_id', 'status'],
    },
    async run(input) {
      const cfg = readConfig();
      const filial = (input.filial_code ?? cfg.filial ?? '').trim();
      const { successes } = await write('orderChangeStatus', {
        order: [{ filial_code: filial, deal_id: String(input.deal_id), status: String(input.status) }],
      });
      return reply(
        { результат: 'статус изменён', deal_id: String(input.deal_id), новый_статус: String(input.status), филиал: filial },
        successes,
      );
    },
  },

  {
    name: 'smartup_order_note',
    title: 'Примечание к заказу',
    description:
      'Пишет примечание в шапку существующего заказа, не трогая его состав. Требует включённого режима записи. ' +
      'Прежнее примечание заменяется целиком.',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string', description: 'Номер сделки' },
        note: { type: 'string', description: 'Текст примечания. Заменяет прежний целиком' },
        filial_code: { type: 'string' },
      },
      required: ['deal_id', 'note'],
    },
    async run(input) {
      const cfg = readConfig();
      const filial = (input.filial_code ?? cfg.filial ?? '').trim();
      const { successes } = await write('orderAttachData', {
        order: [{ filial_code: filial, deal_id: String(input.deal_id), note: String(input.note) }],
      });
      return reply({ результат: 'примечание записано', deal_id: String(input.deal_id), текст: String(input.note) }, successes);
    },
  },

  {
    name: 'smartup_contractor_create',
    title: 'Завести контрагента или точку',
    description:
      'Создаёт юрлицо в справочнике. Точка сети — это то же юрлицо с parent_person_code головной карточки: ' +
      'отдельной сущности «точка» в API нет. Требует включённого режима записи. Повтор с тем же кодом обновляет ' +
      'карточку, а не создаёт вторую.',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Название. В учётной системе оно уникально на всю организацию' },
        code: { type: 'string', description: 'Код карточки. Если не задан, будет сгенерирован' },
        parent_person_code: { type: 'string', description: 'Код головной карточки — так заводится точка сети' },
        tin: { type: 'string', description: 'ИНН' },
        address: { type: 'string', description: 'Адрес доставки' },
        phone: { type: 'string', description: 'Телефон на точке' },
        region_code: { type: 'string', description: 'Код региона, если он обязателен в вашем контуре' },
        room_code: { type: 'string', description: 'Рабочая зона' },
        is_supplier: { type: 'boolean', description: 'Это поставщик, а не клиент. По умолчанию клиент' },
        filial_code: { type: 'string' },
      },
      required: ['name'],
    },
    async run(input) {
      const cfg = readConfig();
      const filial = (input.filial_code ?? cfg.filial ?? '').trim();
      const code = String(input.code ?? generatedId('MCP-PT')).trim();

      const person = {
        filial_code: filial,
        external_id: `mcp-person-${code}`,
        code,
        name: String(input.name),
        short_name: String(input.name).slice(0, 60),
        state: 'A',
        is_client: input.is_supplier ? 'N' : 'Y',
        is_supplier: input.is_supplier ? 'Y' : 'N',
        is_budgetarian: 'N',
        // Ключ остаётся даже пустым: он в списке обязательных, а зоны у
        // клиента может не быть вовсе
        rooms: input.room_code ? [{ room_code: String(input.room_code) }] : [],
      };
      if (input.parent_person_code) person.parent_person_code = String(input.parent_person_code);
      if (input.tin) person.tin = String(input.tin);
      if (input.address) person.address = String(input.address);
      if (input.phone) person.main_phone = String(input.phone);
      if (input.region_code) person.region_code = String(input.region_code);

      const { successes } = await write('legalPersonImport', { legal_person: [person] });
      return reply(
        {
          результат: 'карточка принята учётной системой',
          код: code,
          название: person.name,
          тип: input.parent_person_code ? 'точка сети' : input.is_supplier ? 'поставщик' : 'клиент',
          родитель: person.parent_person_code ?? null,
          филиал: filial,
        },
        successes,
      );
    },
  },
];
