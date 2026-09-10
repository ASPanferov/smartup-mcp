# SmartUp MCP

**[English](README.md) · [Русский](README.ru.md) · [O'zbekcha](README.uz.md)**

An [MCP](https://modelcontextprotocol.io) server for **SmartUp ERP**. It lets an AI assistant read orders, stock, prices, contractors, payments and debts from your accounting system — and, when you explicitly allow it, create orders and update them.

Works with Claude Desktop, Claude Code, OpenAI Codex, OpenClaw, Hermes and any other MCP client.

```
You:  Which clients owe us money, and who should I call first?
AI:   [smartup_debt] → 8 clients with outstanding balance, 18.2M UZS total.
      Yapona Mama owes 6.9M — shipped in July, no payment since.
      Jononchicken owes 8.1M but has 13.5M in open orders — call before shipping more.
```

---

## What it does

**19 tools in three groups.**

### Reading

| Tool | Answers |
|---|---|
| `smartup_orders` | Orders for a period, with line items and statuses |
| `smartup_order` | One order in full, by deal id or external id |
| `smartup_stock` | Free stock by product and warehouse, with names resolved |
| `smartup_products` | Product catalogue: name, code, article, box size |
| `smartup_prices` | Prices by price type |
| `smartup_contractors` | Legal entities and their retail points |
| `smartup_payments` | Incoming payments for a period |
| `smartup_returns` | Returns for a period |
| `smartup_staff` | Sales managers: staff codes, names and the zones they work in |
| `smartup_order_defaults` | Which codes an order will use and where they came from |
| `smartup_reference` | Warehouses, product groups, producers, price types, contracts, routes |
| `smartup_export` | Direct call to any `$export` method, when a ready-made tool is not enough |
| `smartup_usage` | How many requests the connector has spent today |

### Reports

These do not exist as API endpoints. Each is two or three exports plus arithmetic on top.

| Tool | Answers |
|---|---|
| `smartup_debt` | Who owes what: shipped − paid − returned, per client |
| `smartup_sales` | Sales breakdown by client, product, day or status, with shares |

### Writing — off by default

| Tool | Does |
|---|---|
| `smartup_order_create` | Creates an order (a draft unless you ask otherwise) |
| `smartup_order_status` | Changes an order status: post, cancel, move along the pipeline |
| `smartup_order_note` | Writes a note into an order header |
| `smartup_contractor_create` | Creates a legal entity or a retail point of a chain |

---

## Safety

Writing into a live accounting system is not the same as reading from it. Three rules make the difference explicit rather than implicit.

**Writing is off until you turn it on.** The default configuration reads only. Every write tool is still listed — so the assistant can say "this is disabled in settings" instead of "I can't do that" — but the call is refused before it reaches the network.

**Writing goes to exactly one branch.** When write mode is on, the connector only accepts requests addressed to the `filial_code` from your settings. A request without a branch is refused too: SmartUp serves a branchless request against the account's *default* organisation, which is usually the production one.

**Orders are created as drafts.** Unless you pass an explicit status, a new order lands as `D` — visible to a manager, invisible to the warehouse. Every write carries an idempotency key, so a retry after a network failure updates the same document instead of creating a second one.

**Daily quotas are shared with real work.** SmartUp limits API calls per day — around a hundred for reference data, several hundred for documents — and those limits are the same ones your shipping operation uses. The connector counts its own calls, stops before the shared limit is gone, and caches reference data for six hours. `smartup_usage` shows the current spend.

---

## Install

### Claude Desktop — one click

Download `smartup.mcpb` from [Releases](https://github.com/ASPanferov/smartup-mcp/releases), then drag it into the Claude Desktop window (or double-click it, or use **Settings → Extensions → Advanced → Install Extension**).

Claude will ask for the settings itself:

| Field | Meaning |
|---|---|
| **Login** | SmartUp user the connector acts as |
| **Password** | Stored in the OS keychain, never in a file |
| **Branch code** | Default branch, e.g. `220.012`. Required for writing |
| **Allow data changes** | Off by default. Turn on only if you want the assistant to create orders |
| **Server address** | `https://smartup.online` unless your SmartUp lives elsewhere |
| **Daily request limit** | Default 60 |

### Any other client — from source

```bash
git clone https://github.com/ASPanferov/smartup-mcp.git
cd smartup-mcp
npm install
```

Then point your client at `server/index.js` and pass credentials through the environment:

| Variable | Required | Default |
|---|---|---|
| `SMARTUP_LOGIN` | yes | — |
| `SMARTUP_PASSWORD` | yes | — |
| `SMARTUP_FILIAL_CODE` | for writing | — |
| `SMARTUP_ALLOW_WRITE` | no | `false` |
| `SMARTUP_BASE_URL` | no | `https://smartup.online` |
| `SMARTUP_DAILY_BUDGET` | no | `60` |

---

## Connecting

### Claude Code

```bash
claude mcp add smartup \
  --env SMARTUP_LOGIN=your_login \
  --env SMARTUP_PASSWORD=your_password \
  --env SMARTUP_FILIAL_CODE=220.012 \
  -- node /absolute/path/to/smartup-mcp/server/index.js
```

Or commit it to the project as `.mcp.json`, keeping secrets in the environment:

```json
{
  "mcpServers": {
    "smartup": {
      "command": "node",
      "args": ["/absolute/path/to/smartup-mcp/server/index.js"],
      "env": {
        "SMARTUP_LOGIN": "${SMARTUP_LOGIN}",
        "SMARTUP_PASSWORD": "${SMARTUP_PASSWORD}",
        "SMARTUP_FILIAL_CODE": "220.012"
      }
    }
  }
}
```

Check with `/mcp` inside a session.

### OpenAI Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.smartup]
command = "node"
args = ["/absolute/path/to/smartup-mcp/server/index.js"]

[mcp_servers.smartup.env]
SMARTUP_LOGIN = "your_login"
SMARTUP_PASSWORD = "your_password"
SMARTUP_FILIAL_CODE = "220.012"
```

Or `codex mcp add smartup -- node /absolute/path/to/smartup-mcp/server/index.js`. Verify with `codex mcp list`.

### OpenClaw

```bash
openclaw mcp add smartup \
  --command node \
  --arg /absolute/path/to/smartup-mcp/server/index.js \
  --transport stdio
```

Or in `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "smartup": {
        "command": "node",
        "args": ["/absolute/path/to/smartup-mcp/server/index.js"],
        "transport": "stdio",
        "enabled": true
      }
    }
  }
}
```

Credentials belong in the environment OpenClaw launches with, not in the config literal. Verify with `openclaw mcp doctor smartup --probe`.

### Hermes

In `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  smartup:
    command: "node"
    args: ["/absolute/path/to/smartup-mcp/server/index.js"]
    env:
      SMARTUP_LOGIN: "${env:SMARTUP_LOGIN}"
      SMARTUP_PASSWORD: "${env:SMARTUP_PASSWORD}"
      SMARTUP_FILIAL_CODE: "220.012"
    enabled: true
```

Secrets go into `~/.hermes/.env`. Verify with `hermes tools list`.

### Anything else

The server speaks MCP over stdio. Command `node`, single argument — the absolute path to `server/index.js`, credentials in the environment. That is all any MCP client needs.

---

## How it talks to SmartUp

Three things about this API shape everything in the code, and they will surprise you if you meet them for the first time in production:

**Everything is POST**, including reads. There are no GET endpoints.

**Errors arrive as HTTP 200.** A refusal is a valid JSON body with `error_code`, or plain Russian text, or an `errors[]` array next to `successes[]`. A response that arrives is not a response that succeeded.

**Two incompatible response shapes.** Most endpoints answer `{ "<entity>": [...], "limits": {...} }`; the `/api/v2/` ones answer `{ "count": "1", "data": [...] }`. One endpoint — `product_price$export` — is `/api/v2/` but still uses the entity key. The connector handles all three.

Dates go in as `dd.mm.yyyy`. Tools accept `2026-09-06`, `06.09.2026`, `yesterday` or `-7d` and convert.

### Codes an order needs — and the error that lies about them

Creating an order requires codes a human has no way to look up: work zone, sales staff, price type, warehouse, robot. There is **no staff endpoint in the API at all** — `staff$export` answers 404 — and the code on a client's card may point at a zone with nobody assigned to it.

Worse, the refusal arrives under the wrong name. An order without `room_code` is rejected with *"Штат не найден. Код штата ="* — "staff not found" — because SmartUp derives the staff **from the zone** and, finding no zone, reports an empty staff code. You go hunting for a manager while the missing piece is the zone.

So the connector does not ask you for these codes. It reads them off orders that already went through — codes that are provably valid, since the document exists — and tells you what it used:

```
"подставлено_автоматически": {
  "room_code": "000001", "sales_manager_code": "012",
  "price_type_code": "B2B", "warehouse_code": "124799"
},
"источник_кодов": "заказы этого клиента"
```

Pass `no_autofill: true` to turn this off, or `smartup_order_defaults` to see the codes before writing anything.

---

## Development

```bash
npm start                    # run the server on stdio
npx @anthropic-ai/mcpb pack  # build smartup.mcpb
```

The server is plain ES modules, no build step. `server/smartup.js` is the API client, guards and quota counter; `server/tools.js` reading; `server/reports.js` the computed summaries; `server/write.js` everything that changes data; `server/format.js` how answers are shaped.

Pull requests are welcome — especially tools for parts of SmartUp we have not covered.

---

## Author and licence

Made by **Artem Panferov** — [panferov.uz](https://panferov.uz) — at **AI LAB**, [ailab.uz](https://ailab.uz).

Released under the [MIT licence](LICENSE). Open source, free to use, fork and modify.

### Disclaimer

This is an independent project. It is **not affiliated with, endorsed by, or supported by SmartUp** or its developers.

The software is provided "as is", without warranty of any kind. **The author and AI LAB accept no liability** for any errors, data loss, incorrect documents, financial consequences or security incidents arising from its use.

You are responsible for your own data and credentials. Two things deserve particular care:

- **Write mode gives an AI assistant the ability to create documents in your accounting system.** Review what it produces. Keep it off unless you need it.
- **The connector holds credentials to your ERP.** Treat the machine it runs on accordingly.

Test on a non-production branch first.
