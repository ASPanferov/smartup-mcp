#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, runTool } from './tools.js';

/**
 * Коннектор SmartUp для Claude Desktop.
 *
 * Работает по stdio: Claude запускает этот процесс и разговаривает с ним
 * через стандартный ввод-вывод. Отсюда два правила, нарушение которых
 * выглядит как «расширение не запускается»:
 *
 *  - в stdout нельзя писать ничего, кроме протокола. Любой console.log ломает
 *    поток JSON-RPC. Всё, что нужно сказать, идёт в stderr — Claude покажет
 *    это в логах расширения;
 *  - процесс не должен падать. Необработанное исключение убивает соединение
 *    на середине разговора, и человек видит только исчезнувший инструмент.
 */

const server = new Server(
  { name: 'smartup', version: '1.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    /*
     * Аннотации — не украшение: по ним клиент решает, спрашивать ли
     * подтверждение перед вызовом. Инструменты записи помечаем честно, иначе
     * заведение заказа проходило бы так же тихо, как вопрос про остаток.
     */
    annotations: {
      title: t.title,
      readOnlyHint: !t.destructive,
      destructiveHint: Boolean(t.destructive),
      // Повтор безопасен у всех: у чтения по определению, у записи — за счёт
      // ключа идемпотентности, по которому учётная система обновляет документ
      idempotentHint: true,
      openWorldHint: true,
    },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) =>
  runTool(req.params.name, req.params.arguments ?? {}),
);

process.on('uncaughtException', (e) => {
  console.error('[smartup] необработанная ошибка:', e?.stack ?? e);
});
process.on('unhandledRejection', (e) => {
  console.error('[smartup] необработанный отказ:', e);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  '[smartup] коннектор запущен, инструментов:',
  TOOLS.length,
  '| запись:',
  ['true', '1', 'yes', 'on', 'да'].includes(String(process.env.SMARTUP_ALLOW_WRITE ?? '').trim().toLowerCase())
    ? `разрешена в филиал ${process.env.SMARTUP_FILIAL_CODE || '(не задан — запись не сработает)'}`
    : 'выключена',
);
