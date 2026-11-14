# OpenCode Central

[English](central.md) · **ไทย**

monitor ตัวเดียวสำหรับหลายเครื่อง ทุกเครื่องที่รัน OpenCode ส่งตัวเลขของตัวเองไปที่ hub แล้ว hub แสดงทุกเครื่องในหน้าเดียว และเขียนตัวเลขสำคัญลง InfluxDB ไม่มีข้อความ โค้ด หรือ path ไฟล์ใดออกจากเครื่องเลย อยู่ใน branch `central` ทุกอย่างใน [README](../README.th.md) หลักยังใช้ได้กับแต่ละเครื่องตามปกติ

<a id="what"></a>

## ใช้ทำอะไร

monitor ปกติตอบว่า "OpenCode บนเครื่องนี้กำลังทำอะไร" ส่วน OpenCode Central ตอบว่า "OpenCode บนทุกเครื่องเป็นอย่างไร และอะไรเปลี่ยนไปเมื่อ OpenCode, เซิร์ฟเวอร์โมเดล หรือค่าตั้งค่าเปลี่ยน" โดยเก็บเวลา จำนวน token สถานะ และเวอร์ชันของทุก session ไว้ที่เดียว คุณ (หรือ Claude ผ่าน MCP ในอนาคต) จะได้เทียบก่อน/หลังการเปลี่ยนแปลงแล้วตัดสินใจว่าควรปรับอะไร ระบบนี้แสดงและเก็บข้อมูลอย่างเดียว ไม่เคยแก้ OpenCode ค่าตั้งค่า หรือเซิร์ฟเวอร์โมเดล

<a id="how"></a>

## ทำงานอย่างไร

```
 machine A ─┐                                      ┌─ page: every machine, a picker
 machine B ─┼─ agent (node server.mjs --agent) ──► │  hub (node server.mjs --central, Docker)
 machine C ─┘   reads opencode.db read-only,       ├─ one OpenCode-shaped SQLite file per machine
                strips all text, seals the batch,  └─ key figures → InfluxDB (optional)
                queues it on disk, POSTs /ingest
```

- **ตัวส่ง (agent)** (`--agent` บนทุกเครื่องที่รัน OpenCode): ทุก 10 วินาทีจะอ่านเฉพาะส่วนที่เปลี่ยนในฐานข้อมูลของ OpenCode (อ่านอย่างเดียว ถ้าฐานข้อมูลถูกล็อกก็ข้ามรอบนั้น) รวมกับสิ่งที่เห็นได้เฉพาะบนเครื่อง (OpenCode รันอยู่ไหม เวอร์ชัน permission ที่รออยู่ branch ของโปรเจกต์ และ limit ของโมเดลใน config ของ OpenCode) ตัดข้อความทุกชนิดออก (ดูด้านล่าง) เข้ารหัส batch ด้วยกุญแจสาธารณะของ hub (X25519 + HKDF-SHA256 + AES-256-GCM) เขียนลงคิวบนดิสก์แล้วส่งไป ถ้าติดต่อ hub ไม่ได้ ตัวส่งจะไม่หยุด batch จะรอในคิว (สูงสุด 200 MB หรือ 30 วัน) แล้วส่งตามลำดับภายหลัง การซิงก์ครั้งแรกส่งแค่ 30 วันล่าสุด (`central.sinceDays`)
- **hub** (`--central` ปกติรันใน Docker): `POST /ingest` รับ batch จากเครื่องที่แสดง token ของตัวเอง เปิด batch แล้วปฏิเสธทันทีถ้ายังมีข้อความใดที่ดูเหมือนเนื้อหา จากนั้นเขียนแถวลง `<dir>/machines/<machine>/opencode.db` ซึ่งมีโครงสร้างเดียวกับฐานข้อมูลของ OpenCode เอง monitor ตัวเดิมจึงรันบนไฟล์เหล่านี้ได้โดยไม่ต้องแก้ หน้าเว็บทำงานเหมือนบนเครื่องเดียว แต่มีตัวเลือกเครื่อง เก็บข้อมูล 180 วัน และถ้าตั้ง `central.influx` ไว้ ทุก batch จะถูกเขียนเป็นจุดข้อมูลใน InfluxDB ด้วย

<a id="data"></a>

## ข้อมูลอะไรออกจากเครื่อง

| ส่ง | ไม่ส่งเด็ดขาด |
| --- | --- |
| เวลา ระยะเวลา จำนวน token (เข้า ออก reasoning cache) ค่าใช้จ่าย | prompt ของคุณ คำตอบของโมเดล การคิดของโมเดล |
| สถานะ session ชื่อ tool และ MCP server สำเร็จหรือล้มเหลว | ผลลัพธ์ของ tool เนื้อไฟล์ ข้อความ error |
| ชื่อโมเดลและ provider limit ของโมเดลและค่า compaction | คำสั่ง path ไฟล์ URL คำถามที่ agent ถามคุณ |
| เวอร์ชัน OpenCode ชื่อเครื่อง OS | ข้อความในแผนงาน (todo) pattern ของ permission |
| ชื่อ session ชื่อโฟลเดอร์โปรเจกต์ (ไม่ใช่ path) ชื่อ branch | key ที่อยู่ของเซิร์ฟเวอร์โมเดล คำสั่งเริ่ม MCP |

วิธีการ: ใช้ whitelist คัดลอกเฉพาะฟิลด์ที่อยู่ในรายการ ฟิลด์ใหม่ที่ OpenCode เพิ่มในอนาคตจะถูกทิ้งเอง ข้อความถูกแทนด้วยตัวเติม (`·`) ความยาวเท่าเดิม ตัวเลขที่นับความยาวจึงยังใช้ได้ input ของ tool ถูกแทนด้วย hash ที่มีกุญแจ (HMAC-SHA256 ด้วยกุญแจที่สร้างบนเครื่องนั้น) การเรียกแบบเดิมสองครั้งจึงยังจับว่าวนซ้ำได้ path ไฟล์ก็ถูกแทนด้วย hash เช่นกัน และ hub ตรวจทุก batch ซ้ำอีกรอบ ถ้ายังมีข้อความหลุดมาจะปฏิเสธทั้ง batch

ส่วนของหน้าเว็บที่ต้องใช้ข้อความจะไม่มีบน hub ได้แก่ Replay, "เครื่องนี้", ไฟล์ที่แตะ, process ที่ทิ้งไว้, tool call ที่ถูกติดธง, รายการในแผนงาน และข้อความคำสั่ง ถ้าต้องการดูส่วนเหล่านี้ ให้รัน monitor ปกติบนเครื่องนั้นเอง

<a id="security"></a>

## โมเดลความปลอดภัย

- **เครื่อง → hub:** แต่ละเครื่องมี token ของตัวเอง hub เก็บแค่ SHA-256 ของ token และการออก token ใหม่จะเพิกถอนของเก่า `/ingest` รับข้อมูลอย่างเดียว ตอบแค่ `{"ok":true,"seq":n}` หรือ `{"ok":false}`
  - token ผิด: 401
  - ใหญ่เกิน: 413
  - เสียหายหรือยังมีเนื้อหา: 400
- **ทุก batch เข้ารหัสด้วยกุญแจของ hub:** proxy ที่ถอด TLS ระหว่างทางจึงอ่านไม่ได้
- **หน้าเว็บและ API ต้องใช้ access key ของ monitor** (`lan: true`) เหมือนใน README หลัก มีแค่ `/health` และ `/ingest` (ซึ่งตรวจ token อยู่แล้ว) ที่เข้าได้โดยไม่ต้องใช้ key
- **hub รันแบบอ่านอย่างเดียว:** ไม่มีสิทธิ์ (capabilities) ของ Linux และไม่ได้รันด้วย root กุญแจลับและ hash ของ token อยู่ใน volume ข้อมูลของมัน
- **ห้ามใส่ลงใน git, issue หรือแชตเด็ดขาด:** token, กุญแจลับของ hub, access key และ config ที่กรอกค่าแล้ว

<a id="requirements"></a>

## สิ่งที่ต้องมี

- **hub:** Docker พร้อม Compose (Docker Desktop บน Windows ใช้ได้), พอร์ต TCP ว่างหนึ่งพอร์ต (4317) และทุกเครื่องต้องเข้าถึงได้
- **ตัวส่ง:** Node.js 22.13 ขึ้นไป และ OpenCode บนเครื่องเดียวกัน
- **ไม่บังคับ:** InfluxDB 2.x พร้อม bucket สำหรับตัวเลข และ token ที่เขียนได้เฉพาะ bucket นั้น

<a id="hub"></a>

## ติดตั้ง hub

<a id="hub-code"></a>

### 1. ดึงโค้ดและสร้างไฟล์ตั้งค่า

```sh
git clone --branch central https://github.com/adcident12/opencode-monitor
cd opencode-monitor/deploy/central
```

สร้าง `data/config.json` โดยใช้ `config.example.json` เป็นแบบ (โฟลเดอร์ `data/` ถูก git ignore ไว้แล้ว) ถ้าไม่ใช้ InfluxDB ให้ตัดส่วน `influx` ออก:

```json
{
  "port": 4317,
  "lan": true,
  "pollMs": 5000,
  "notify": { "desktop": false },
  "history": { "file": "/data/history/history.jsonl", "retentionDays": 180 },
  "central": { "dir": "/data/central", "hosts": ["<hub LAN address>:4317"] }
}
```

`hosts` คือชื่อที่เครื่องอื่นใช้เรียก hub (เช่นที่อยู่ LAN พร้อมพอร์ต) คำขอที่มาด้วยชื่ออื่นจะถูกปฏิเสธ เพื่อกันหน้าเว็บจากการโจมตีแบบ DNS rebinding

<a id="hub-keys"></a>

### 2. build สร้างกุญแจ แล้วเริ่ม

```sh
docker compose build
docker compose run --rm central --central-init
docker compose up -d
```

`--central-init` สร้างคู่กุญแจของ hub ครั้งเดียวแล้วพิมพ์กุญแจสาธารณะออกมา กุญแจสาธารณะไม่ใช่ความลับ ต้องใส่ใน config ของตัวส่งทุกเครื่อง ตรวจ:

```sh
docker ps --filter name=opencode-central
curl http://127.0.0.1:4317/health
```

<a id="hub-firewall"></a>

### 3. เปิดให้เครื่องอื่นเข้าถึง

บน Windows แม้ Docker Desktop จะเปิดพอร์ตแล้ว Windows Firewall ก็ยังกันไว้ ให้เปิด PowerShell แบบ administrator แล้วอนุญาตเฉพาะจากวง LAN:

```powershell
New-NetFirewallRule -DisplayName "OpenCode Central hub (LAN only)" -Direction Inbound -Protocol TCP -LocalPort 4317 -RemoteAddress LocalSubnet -Action Allow -Profile Any
```

จากเครื่องอื่น `curl http://<hub LAN address>:4317/health` ต้องตอบ `{"ok":true}`

<a id="hub-token"></a>

### 4. token ของแต่ละเครื่อง

```sh
docker compose run --rm central --central-token <machine>
```

`<machine>` คือ `a-z`, `0-9` และ `-` ยาว 1 ถึง 32 ตัว token จะพิมพ์ออกมาครั้งเดียว ใส่ใน config ของเครื่องนั้นเท่านั้น ห้ามเก็บไว้ที่อื่น ถ้ารันคำสั่งนี้ซ้ำกับเครื่องเดิม token เก่าจะถูกแทนที่ (เพิกถอน)

<a id="hub-influx"></a>

### 5. InfluxDB (ไม่บังคับ)

สร้าง bucket (เก็บ 180 วัน) และ token ที่เขียนได้เฉพาะ bucket นั้น บนเครื่องที่รัน InfluxDB:

```sh
influx bucket create --name opencode --retention 4320h --org <org>
influx auth create --org <org> --write-bucket <bucket id> --description "opencode-central hub (write only)"
```

เพิ่มลงใน `central` ของ `data/config.json` แล้ว `docker compose restart`:

```json
"influx": { "url": "http://<influxdb host>:8086", "org": "<org>", "bucket": "opencode", "token": "<write-only token>" }
```

จุดข้อมูลที่เขียน (เวลาของจุด = เวลาที่เหตุการณ์เกิดจริง ระดับ ns):

| Measurement | Tags | Fields |
| --- | --- | --- |
| `opencode_request` | machine, project, provider, model | tokens_in, tokens_out, reasoning, cache_read, cache_write, cost, duration_ms |
| `opencode_tool` | machine, project, tool, status | duration_ms |
| `opencode_compaction` | machine, project, auto | n |
| `opencode_state` | machine, project, from, to | seconds (เวลาที่อยู่ในสถานะก่อนเปลี่ยน) |
| `opencode_version` | machine | version |

จุดข้อมูลเริ่มเขียนตั้งแต่ hub มีค่า `influx` ครั้งแรก batch ที่รับไปก่อนหน้านั้นจะไม่ถูกเขียนย้อนหลัง

<a id="agent"></a>

## ติดตั้งตัวส่ง

บนทุกเครื่องที่รัน OpenCode:

```sh
git clone --branch central https://github.com/adcident12/opencode-monitor
cd opencode-monitor
```

สร้าง `config.json` ไว้ข้าง `server.mjs` (ถูก git ignore ไว้แล้ว):

```json
{
  "notify": { "desktop": false },
  "central": {
    "url": "http://<hub LAN address>:4317",
    "machine": "<machine>",
    "token": "<this machine's token>",
    "publicKey": "<the hub's public key>",
    "everyMs": 10000,
    "sinceDays": 30
  }
}
```

ลองรันในหน้าต่าง terminal หนึ่งครั้งเพื่อดูว่าทำงาน แล้วหยุด (Ctrl+C) จากนั้นตั้งให้เริ่มเองทุกครั้งที่ login:

```sh
node server.mjs --agent
node server.mjs --agent --autostart on
```

บน Windows ให้เริ่ม task ทันทีด้วย `schtasks /Run /TN opencode-monitor` ส่วนบน macOS และ Linux `--autostart on` จะเริ่มให้เลย ตัวส่งเก็บสถานะไว้ใน `data/agent/` (คิว ตำแหน่งที่อ่านถึง และกุญแจ hash)

task เริ่มอัตโนมัติใช้ชื่อเดียวกับของ monitor ปกติ แต่ละเครื่องจึงเริ่มตอน login ได้อย่างเดียว คือตัวส่งหรือ monitor ปกติ ส่วน monitor ปกติยังเปิดเองด้วยมือบนพอร์ตอื่นได้ (`node server.mjs --port 4318`)

<a id="check"></a>

## ตรวจว่าใช้งานได้

1. ใช้ OpenCode บนเครื่องนั้นสักนาที
2. บน hub: `docker logs opencode-central --tail 5` จะขึ้นชื่อเครื่องหลังรีสตาร์ต และมีโฟลเดอร์ของเครื่องนั้นใน `data/central/machines/`
3. เปิด `http://<hub LAN address>:4317/?key=<access key>` หนึ่งครั้ง (key อยู่ใน `data/history/access-key` บน hub) หน้าเว็บจะจำไว้ แล้วเลือกเครื่องที่ด้านบน
4. ถ้าใช้ InfluxDB: `from(bucket:"opencode") |> range(start:-1h)` ต้องเห็นจุด `opencode_request` ของเครื่องนั้น

ฝั่งตัวส่ง: โฟลเดอร์ `data/agent/outbox/` ควรว่างภายในไม่กี่วินาที
- **ไฟล์ค้างอยู่:** ติดต่อ hub ไม่ได้
- **มีไฟล์ใน `data/agent/outbox/rejected/`:** hub ปฏิเสธถาวร (ใหญ่เกินหรือยังมีเนื้อหา) เก็บไว้ให้ตรวจดู

<a id="claude"></a>

## ให้ Claude Code ติดตั้งให้

หน้านี้เขียนไว้ให้ Claude Code บนเครื่องอื่นติดตั้งตามได้ กติกาสำหรับผู้ช่วยที่ทำงานนี้:

- ทำตามหัวข้อข้างบนตามลำดับ ตรวจผลของแต่ละขั้นก่อนไปขั้นถัดไป
- ห้ามพิมพ์ อ่านออกมา commit หรือส่งในแชตเด็ดขาด: token, `data/central/hub-key.json`, `data/history/access-key` และ `config.json` ที่กรอกค่าแล้ว เมื่อต้องใส่ token ลงไฟล์ ให้ขอให้เจ้าของวางลงในไฟล์เอง (หรือในช่อง prompt บนเครื่องนั้น) แทนการส่งผ่านบทสนทนา
- คำสั่งที่ต้องใช้สิทธิ์ administrator (rule ของ firewall) ให้เจ้าของเป็นคนรัน
- ถามก่อนเขียนทับ `config.json` ที่มีอยู่ หรือ task เริ่มอัตโนมัติ `opencode-monitor` ที่มีอยู่
- รายงานว่าทำอะไรไปแล้วและเหลืออะไร พร้อมผลการตรวจตามหัวข้อ "ตรวจว่าใช้งานได้"

<a id="limits"></a>

## ข้อจำกัด

- **ขั้นที่ 1 ใช้ในวง LAN:** การเข้าถึงจากอินเทอร์เน็ต (reverse proxy ที่ถอด TLS ที่บ้าน พร้อม login ของตัวเอง) อยู่ในแผน ยังไม่ได้สร้าง
- **hub ยังไม่มี MCP:** MCP บนแต่ละเครื่อง (`mcp.mjs`) ยังตอบเฉพาะเครื่องนั้น
- **hub ยังไม่เก็บตัวเลขของเซิร์ฟเวอร์โมเดล (llama.cpp)**
- **เครื่องที่อยู่ต่างประเทศหลังตัวกรองประเทศ หรือออฟไลน์:** แค่รอในคิว ไม่มีอะไรหายตราบที่ไม่เกินเพดานคิว
- **ลบ session ใน OpenCode:** ไม่ได้ลบบน hub จะหมดอายุเองหลัง 180 วัน

<a id="troubleshooting"></a>

## แก้ปัญหา

- **`/health` ใช้ได้บน hub แต่เครื่องอื่นเข้าไม่ได้:** firewall (ดูขั้นที่ 3)
- **หน้าเว็บตอบ 403:** ที่อยู่ที่ใช้เปิดไม่อยู่ใน `central.hosts`
- **InfluxDB ไม่มีจุดข้อมูล:** ถ้าเขียนล้มเหลว hub จะบันทึก `central: InfluxDB: …` ไว้ใน log ถ้าไม่มีทั้งบรรทัด log และจุดข้อมูล แปลว่า config ที่ container อ่านไม่มี `influx` อยู่ใน `central` หรือยังไม่ได้รีสตาร์ต hub
- **ตัวส่งขึ้น `central.<field> …` ตอนเริ่ม:** ค่านั้นหายหรือไม่ถูกต้อง ข้อความบอกชื่อค่าไว้แล้ว
- **ติดตั้งเครื่องใหม่:** ออก token ใหม่ให้เครื่องนั้น คิวของมันจะเริ่ม instance ใหม่ และ hub จะนับ batch ของเครื่องนั้นจาก 1 ใหม่
