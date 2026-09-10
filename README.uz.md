# SmartUp MCP

**[English](README.md) · [Русский](README.ru.md) · [O'zbekcha](README.uz.md)**

**SmartUp ERP** uchun [MCP](https://modelcontextprotocol.io) server. AI-yordamchiga hisob tizimingizdan buyurtmalar, qoldiqlar, narxlar, kontragentlar, to'lovlar va qarzlarni o'qish imkonini beradi — siz ruxsat bersangiz, buyurtma yaratish va o'zgartirish ham mumkin.

Claude Desktop, Claude Code, OpenAI Codex, OpenClaw, Hermes va boshqa har qanday MCP mijozi bilan ishlaydi.

```
Siz: Kim bizga qarzdor va birinchi bo'lib kimga qo'ng'iroq qilish kerak?
AI:  [smartup_debt] → 8 ta mijozda qarz bor, jami 18,2 mln so'm.
     Yapona Mama — 6,9 mln, iyulda jo'natilgan, shundan beri to'lov yo'q.
     Jononchicken — 8,1 mln, ammo yana 13,5 mln buyurtma jarayonda.
     Yana jo'natishdan oldin qo'ng'iroq qiling.
```

---

## Imkoniyatlari

**Uchta guruhda 17 ta vosita.**

### O'qish

| Vosita | Qanday savolga javob beradi |
|---|---|
| `smartup_orders` | Davr bo'yicha buyurtmalar, tarkibi va holati bilan |
| `smartup_order` | Bitta buyurtma to'liq: bitim raqami yoki tashqi raqami bo'yicha |
| `smartup_stock` | Tovar va omborlar bo'yicha erkin qoldiq, nomlari bilan |
| `smartup_products` | Nomenklatura: nomi, kodi, artikuli, qadoq |
| `smartup_prices` | Narx turlari bo'yicha narxlar |
| `smartup_contractors` | Yuridik shaxslar va ularning savdo nuqtalari |
| `smartup_payments` | Davr ichida kelgan pullar |
| `smartup_returns` | Davr ichidagi qaytarishlar |
| `smartup_reference` | Omborlar, tovar guruhlari, ishlab chiqaruvchilar, narx turlari, shartnomalar, reyslar |
| `smartup_export` | Tayyor vosita yetmasa — istalgan `$export` metodini to'g'ridan-to'g'ri chaqirish |
| `smartup_usage` | Konnektor bugun nechta so'rov sarflagani |

### Hisobotlar

API'da bunga tayyor metod yo'q. Har biri — ikki-uchta eksport va ustidagi hisob-kitob.

| Vosita | Qanday savolga javob beradi |
|---|---|
| `smartup_debt` | Kim qancha qarzdor: jo'natilgan − to'langan − qaytarilgan, har bir mijoz bo'yicha |
| `smartup_sales` | Savdo hisoboti: mijozlar, tovarlar, kunlar yoki holatlar kesimida, ulushlari bilan |

### Yozish — sukut bo'yicha o'chirilgan

| Vosita | Nima qiladi |
|---|---|
| `smartup_order_create` | Buyurtma yaratadi, sukut bo'yicha qoralama sifatida |
| `smartup_order_status` | Holatni o'zgartiradi: o'tkazish, bekor qilish, keyingi bosqichga surish |
| `smartup_order_note` | Buyurtma sarlavhasiga izoh yozadi |
| `smartup_contractor_create` | Yuridik shaxs yoki tarmoq savdo nuqtasini yaratadi |

---

## Xavfsizlik

Ishlayotgan hisob tizimiga yozish — undan o'qish bilan bir xil narsa emas. Uchta qoida bu farqni yashirin emas, oshkora qiladi.

**Yozish siz yoqmaguningizcha o'chiq turadi.** Sukut bo'yicha konnektor faqat o'qiydi. Yozish vositalari ro'yxatda ko'rinadi — toki yordamchi "men bilmayman" emas, "bu sozlamalarda taqiqlangan" desin — lekin chaqiruv tarmoqqa yetib bormasdan rad etiladi.

**Yozish faqat bitta filialga boradi.** Rejim yoqilganda konnektor faqat sozlamalardagi `filial_code` ga yo'naltirilgan so'rovlarni qabul qiladi. Filialsiz so'rov ham rad etiladi: SmartUp bunday so'rovni **sukut bo'yicha** tashkilot bo'yicha bajaradi, bu esa ko'pincha jangovar kontur bo'ladi.

**Buyurtmalar qoralama sifatida yaratiladi.** Siz holatni aniq aytmasangiz, yangi buyurtma `D` holatida tushadi: menejer uni ko'radi, ombor esa yo'q. Har bir yozuvda idempotentlik kaliti bor, shuning uchun aloqa uzilgandan keyingi takror xuddi shu hujjatni yangilaydi, ikkinchisini yaratmaydi.

**Kunlik kvotalar jangovar ish bilan umumiy.** SmartUp kuniga chaqiruvlar sonini cheklaydi — ma'lumotnomalar uchun taxminan yuzta, hujjatlar uchun bir necha yuzta — va bu o'sha cheklovlar, ular bilan jo'natish ishlaydi. Konnektor o'z chaqiruvlarini sanaydi, oldindan to'xtaydi va ma'lumotnomalarni olti soat keshda saqlaydi. Joriy sarfni `smartup_usage` ko'rsatadi.

---

## O'rnatish

### Claude Desktop — bir harakatda

[Releases](https://github.com/ASPanferov/smartup-mcp/releases) bo'limidan `smartup.mcpb` faylini yuklab oling va Claude Desktop oynasiga sudrab tashlang. Yoki faylni ikki marta bosing, yoki **Sozlamalar → Kengaytmalar → Qo'shimcha → Kengaytma o'rnatish** yo'lidan boring.

Keyin Claude sozlamalarni o'zi so'raydi:

| Maydon | Ma'nosi |
|---|---|
| **Login** | Konnektor uning nomidan ishlaydigan SmartUp foydalanuvchisi |
| **Parol** | Faylda emas, tizim kalitlar omborida saqlanadi |
| **Filial kodi** | Sukut bo'yicha filial, masalan `220.012`. Yozish uchun majburiy |
| **Ma'lumotlarni o'zgartirishga ruxsat** | Sukut bo'yicha o'chiq. Faqat yordamchi buyurtma yaratishini xohlasangiz yoqing |
| **Server manzili** | SmartUp'ingiz boshqa manzilda bo'lmasa — `https://smartup.online` |
| **Kunlik so'rovlar chegarasi** | Sukut bo'yicha 60 |

### Boshqa har qanday mijoz — manbadan

```bash
git clone https://github.com/ASPanferov/smartup-mcp.git
cd smartup-mcp
npm install
```

Keyin mijozga `server/index.js` yo'lini ko'rsating, kirish ma'lumotlarini esa muhit o'zgaruvchilari orqali bering:

| O'zgaruvchi | Majburiy | Sukut bo'yicha |
|---|---|---|
| `SMARTUP_LOGIN` | ha | — |
| `SMARTUP_PASSWORD` | ha | — |
| `SMARTUP_FILIAL_CODE` | yozish uchun | — |
| `SMARTUP_ALLOW_WRITE` | yo'q | `false` |
| `SMARTUP_BASE_URL` | yo'q | `https://smartup.online` |
| `SMARTUP_DAILY_BUDGET` | yo'q | `60` |

---

## Ulanish

### Claude Code

```bash
claude mcp add smartup \
  --env SMARTUP_LOGIN=sizning_loginingiz \
  --env SMARTUP_PASSWORD=sizning_parolingiz \
  --env SMARTUP_FILIAL_CODE=220.012 \
  -- node /toliq/yol/smartup-mcp/server/index.js
```

Yoki loyihaga `.mcp.json` sifatida qo'shing, sirlarni muhitda qoldirib:

```json
{
  "mcpServers": {
    "smartup": {
      "command": "node",
      "args": ["/toliq/yol/smartup-mcp/server/index.js"],
      "env": {
        "SMARTUP_LOGIN": "${SMARTUP_LOGIN}",
        "SMARTUP_PASSWORD": "${SMARTUP_PASSWORD}",
        "SMARTUP_FILIAL_CODE": "220.012"
      }
    }
  }
}
```

Tekshirish — sessiya ichida `/mcp` buyrug'i bilan.

### OpenAI Codex

`~/.codex/config.toml` fayliga:

```toml
[mcp_servers.smartup]
command = "node"
args = ["/toliq/yol/smartup-mcp/server/index.js"]

[mcp_servers.smartup.env]
SMARTUP_LOGIN = "sizning_loginingiz"
SMARTUP_PASSWORD = "sizning_parolingiz"
SMARTUP_FILIAL_CODE = "220.012"
```

Yoki `codex mcp add smartup -- node /toliq/yol/smartup-mcp/server/index.js`. Tekshirish — `codex mcp list`.

### OpenClaw

```bash
openclaw mcp add smartup \
  --command node \
  --arg /toliq/yol/smartup-mcp/server/index.js \
  --transport stdio
```

Yoki `openclaw.json` faylida:

```json
{
  "mcp": {
    "servers": {
      "smartup": {
        "command": "node",
        "args": ["/toliq/yol/smartup-mcp/server/index.js"],
        "transport": "stdio",
        "enabled": true
      }
    }
  }
}
```

Kirish ma'lumotlarini konfiguratsiya faylida emas, OpenClaw ishga tushadigan muhitda saqlang. Tekshirish — `openclaw mcp doctor smartup --probe`.

### Hermes

`~/.hermes/config.yaml` faylida:

```yaml
mcp_servers:
  smartup:
    command: "node"
    args: ["/toliq/yol/smartup-mcp/server/index.js"]
    env:
      SMARTUP_LOGIN: "${env:SMARTUP_LOGIN}"
      SMARTUP_PASSWORD: "${env:SMARTUP_PASSWORD}"
      SMARTUP_FILIAL_CODE: "220.012"
    enabled: true
```

Sirlar — `~/.hermes/.env` faylida. Tekshirish — `hermes tools list`.

### Qolgan hammasi

Server MCP bilan stdio orqali gaplashadi. Buyruq — `node`, yagona argument — `server/index.js` ga to'liq yo'l, kirish ma'lumotlari muhitda. Har qanday MCP mijoziga shundan ortig'i kerak emas.

---

## SmartUp bilan muloqot qanday ishlaydi

Bu API'ning uchta xususiyati koddagi deyarli hamma narsani belgilaydi, va ular bilan birinchi marta jangovar konturda uchrashish yoqimsiz:

**Hammasi POST orqali**, o'qish ham. GET metodlari umuman yo'q.

**Rad javobi 200 kodi bilan keladi.** Bu `error_code` li to'g'ri JSON, oddiy ruscha matn yoki `successes[]` yonidagi `errors[]` massivi bo'lishi mumkin. Bu yerda "javob keldi" degani "hammasi joyida" degani emas.

**Javobning ikkita mos kelmaydigan shakli.** Ko'p metodlar `{ "<mohiyat>": [...], "limits": {...} }` deb javob beradi, `/api/v2/` metodlari esa `{ "count": "1", "data": [...] }`. Bitta metod — `product_price$export` — rasman `/api/v2/`, lekin ildiz kaliti baribir mohiyat nomi bo'yicha. Konnektor uchala holatni ham hal qiladi.

Sanalar `kk.oo.yyyy` ko'rinishida yuboriladi. Vositalar `2026-09-06`, `06.09.2026`, "kecha" yoki `-7d` ni qabul qilib, o'zi o'giradi.

---

## Ishlab chiqish

```bash
npm start                    # serverni stdio'da ishga tushirish
npx @anthropic-ai/mcpb pack  # smartup.mcpb yig'ish
```

Server — oddiy ES modullar, alohida yig'ish kerak emas. `server/smartup.js` — API mijozi, tekshiruvlar va kvota hisoblagichi; `server/tools.js` — o'qish; `server/reports.js` — hisoblanadigan hisobotlar; `server/write.js` — ma'lumotni o'zgartiradigan hamma narsa; `server/format.js` — javoblar qanday tuzilishi.

Pull request'lar mamnuniyat bilan qabul qilinadi — ayniqsa SmartUp'ning biz qamrab olmagan qismlari uchun vositalar.

---

## Muallif va litsenziya

**Artem Panferov** tomonidan yaratilgan — [panferov.uz](https://panferov.uz) — **AI LAB** kompaniyasida, [ailab.uz](https://ailab.uz).

Litsenziya [MIT](LICENSE). Loyiha ochiq: foydalaning, fork qiling, o'zgartiring.

### Javobgarlikdan voz kechish

Bu mustaqil loyiha. U **SmartUp bilan bog'liq emas**, uning ishlab chiquvchilari tomonidan ma'qullanmagan va qo'llab-quvvatlanmaydi.

Dastur "qanday bo'lsa shundayligicha" taqdim etiladi, hech qanday kafolatsiz. **Muallif va AI LAB javobgar emas** — foydalanish natijasida yuzaga kelgan xatolar, ma'lumot yo'qolishi, noto'g'ri yaratilgan hujjatlar, moliyaviy oqibatlar va xavfsizlik hodisalari uchun.

O'z ma'lumotlaringiz va kirish huquqlaringiz uchun siz javobgarsiz. Ayniqsa ikkita narsaga e'tibor bering:

- **Yozish rejimi AI-yordamchiga hisob tizimingizda hujjat yaratish imkonini beradi.** U nima yaratganini tekshiring. Kerak bo'lmaguncha rejimni o'chiq saqlang.
- **Konnektor ERP'ingizga kirish ma'lumotlarini saqlaydi.** U ishlayotgan mashinaga shunga yarasha munosabatda bo'ling.

Avval jangovar bo'lmagan filialda sinab ko'ring.
