# openCycle BLE protocol reference (check in as docs/ble-protocol.md)

Ground truth for the FTMS/HRS codecs and BLE manager. Sources: Bluetooth SIG FTMS v1.0 / HRS v1.0, GoldenCheetah, pycycling, Wahoo release notes/support docs, DC Rainmaker, Makinolo. Compiled 2026-08-25.

## Hardware on site

- 2× Wahoo KICKR CORE "Zwift One" (CORE gen1 + Zwift Cog single-speed + Zwift Click). NOT CORE 2 (no Wi-Fi).
- 2× Garmin HRM-Pro-class straps (2 BLE slots + unlimited ANT+ each).
- 1× Zwift Ride smart frame (two handlebar controllers) on one of the COREs.

## Services to use / avoid

| Peripheral | Use | Avoid |
|---|---|---|
| KICKR CORE | FTMS `0x1826` (control + Indoor Bike Data). Optional CPS `0x1818` as backup power/cadence stream | Zwift proprietary `…19ca-4651-86e5-fa29dcdd09d1` (virtual shifting; Zwift-only), Wahoo proprietary `A026E005-0A7D-4AB3-97FA-F1500F9FEB8B` (legacy ERG; fallback only), DFU/firmware services |
| Garmin HRM | HRS `0x180D` → `0x2A37` notify | ANT+ (no Mac radio) |
| Zwift Ride, left controller | `FC82` (older firmware `00000001-19ca-…`): plain `RideOn`, keypad notifications | The right controller (its presses arrive through the left one) |

Base 128-bit UUID form: `0000XXXX-0000-1000-8000-00805f9b34fb`.

## FTMS characteristics (`0x1826`)

| Name | UUID | Props |
|---|---|---|
| Fitness Machine Feature | `0x2ACC` | Read — 8 bytes: UINT32 features + UINT32 target-setting. Target bit3 = Power Target (ERG). Features bit1 = cadence, bit14 = power |
| Indoor Bike Data | `0x2AD2` | Notify (~1 Hz), CCCD required |
| Supported Power Range | `0x2AD8` | Read — sint16 min W, sint16 max W, uint16 increment. Clamp all targets |
| Fitness Machine Control Point | `0x2AD9` | Write + Indicate. Enable CCCD before any write |
| Fitness Machine Status | `0x2ADA` | Notify |

## Indoor Bike Data `0x2AD2` — little-endian, UINT16 flags then present fields in this order

| # | Field | Size | Type | Scale | Flag |
|---|---|---|---|---|---|
| 1 | Instantaneous Speed | 2 | UINT16 | 0.01 km/h | **bit0 = 0** (More Data inverted!) |
| 2 | Average Speed | 2 | UINT16 | 0.01 km/h | bit1 = 1 |
| 3 | Instantaneous Cadence | 2 | UINT16 | 0.5 rpm | **bit2 = 1** (spec table prints this inverted — errata; GC/pycycling/Huawei all treat 1 = present) |
| 4 | Average Cadence | 2 | UINT16 | 0.5 rpm | bit3 = 1 |
| 5 | Total Distance | 3 | UINT24 | 1 m | bit4 = 1 |
| 6 | Resistance Level | 2 | SINT16 | — | bit5 = 1 |
| 7 | Instantaneous Power | 2 | SINT16 | 1 W | bit6 = 1 |
| 8 | Average Power | 2 | SINT16 | 1 W | bit7 = 1 |
| 9 | Energy: total/­per-hr/­per-min | 2+2+1 | u16,u16,u8 | kcal | bit8 = 1 (all three) |
| 10 | Heart Rate | 1 | UINT8 | bpm | bit9 = 1 |
| 11 | MET | 1 | UINT8 | 0.1 | bit10 = 1 |
| 12 | Elapsed Time | 2 | UINT16 | 1 s | bit11 = 1 |
| 13 | Remaining Time | 2 | UINT16 | 1 s | bit12 = 1 |

Do NOT implement from the GATT XML C-numbers (mislabeled) or web-ble-ftms PACKET_FORMAT.md (wrong speed scale, wrong bit0 polarity).

**Worked vector**: 30.00 km/h, 90.0 rpm, 200 W → `44 00 B8 0B B4 00 C8 00` (flags 0x0044 = bit2|bit6, bit0=0 ⇒ speed present).

Parser skeleton:
```
offset = 2
if !(flags & 0x0001): speed = u16/100; offset += 2
if  (flags & 0x0002): avgSpeed = u16/100; offset += 2
if  (flags & 0x0004): cadence = u16/2; offset += 2
if  (flags & 0x0008): avgCadence = u16/2; offset += 2
if  (flags & 0x0010): distance = u24; offset += 3
if  (flags & 0x0020): resistance = s16; offset += 2
if  (flags & 0x0040): power = s16; offset += 2
... (remaining per table)
```

## Control Point `0x2AD9`

Sequence per trainer session (GoldenCheetah-proven on CORE):
1. Discover; read `0x2ACC` (abort ERG UI if target bit3 clear), read `0x2AD8`.
2. Enable CCCD notify on `0x2AD2` + `0x2ADA`; CCCD on `0x2AD9` — spec says Indicate (`0200`); GC uses Notify (`0100`) and works on CORE. Implement indicate-first, fall back to notify on CCCD write failure.
3. Write `00` (Request Control) → await response `80 00 01`.
4. `07` (Start) is OPTIONAL — GC omits it and ERG works on CORE. Send it; ignore `80 07 02` (op not supported).
5. Write `05` + sint16 LE watts on every target change (never poll/resend unchanged). One in-flight CP write at a time; a second write before the `0x80` response returns ATT "Procedure Already In Progress".
6. Teardown: `08 01` (Stop) or `01` (Reset; also drops control).

| Intent | Bytes |
|---|---|
| Request Control | `00` |
| Reset | `01` |
| Set Target Power 200 W | `05 C8 00` |
| Set Target Power 0 W | `05 00 00` |
| Start/Resume | `07` |
| Stop | `08 01` |  Pause `08 02` |
| SIM params (wind sint16 0.001 m/s, grade sint16 0.01 %, Crr uint8 0.0001, Cw uint8 0.01) | `11 ww ww gg gg cr cw` — e.g. flat default `11 00 00 00 00 28 33` |
| Spin-down start / ignore | `13 01` / `13 02` |

Response indication: `80 <reqOp> <result>` — result `01` Success, `02` Op not supported, `03` Invalid param, `04` Failed, `05` Control Not Permitted.

## Fitness Machine Status `0x2ADA` (notify)

`01` Reset • `02`+u8 Stopped/Paused by user • `04` Started by user • `08`+s16 Target Power Changed • `12`+6B Sim params changed • `14`+u8 Spin Down Status (01 requested, 02 success, 03 error, 04 stop pedaling) • **`FF` Control Permission Lost** → re-run Request Control + resend last target.

## Heart Rate `0x180D` / `0x2A37` (notify, LE)

```
flags: uint8
hr:    uint8 if !(flags & 0x01) else uint16
energy uint16 kJ if flags & 0x08
rr[]:  uint16 × (1/1024 s) if flags & 0x10   // oldest first, may be several
```
flags bits1-2: sensor contact (10 = supported/no contact, 11 = contact). RR→ms: `rr*1000/1024`.
Worked: `16 96 20 03` = 150 bpm, contact, RR 800/1024 s.

## KICKR CORE specifics (gen1 / Zwift One)

- **FTMS ERG works since firmware v1.1.1 (2021-06)**. Pre-1.1.1: only Wahoo proprietary. Require ≥1.1.1; prefer ≥1.5.36 (fixes 2000 W ERG/SIM spike v1.5.5, virtual-shift ghost-watt spindown v1.5.36).
- **3 simultaneous BLE centrals per trainer** (since v1.0.11), but only ONE controller. openCycle must be the sole controlling app: Wahoo app closed or Passive, Zwift closed. Stale phone/ATV connections eat slots — power-cycle trainer 30 s if it won't advertise.
- Two COREs on one Mac = two peripherals under one CBCentralManager — no shared cap. Persist and identify by peripheral UUID; both advertise similar names.
- **Cadence**: integrated estimate, present in Indoor Bike Data bit2 (and CPS). No separate sensor needed. Slight lag after cadence spikes.
- **ERG Power Smoothing** (Wahoo app setting, default ON) rewrites broadcast watts on all clients. Recommend riders disable it once in the Wahoo app for honest traces; not software-controllable via FTMS.
- **Zwift Cog/Click**: irrelevant to ERG. Never connect the Click. Virtual shifting is Zwift-proprietary; ERG apps are Wahoo's supported non-Zwift use of the Cog.
- **Spindown**: auto-spindown since v1.3.17; manual still possible on CORE 1 via FTMS `13 01` if Feature bit15 set.
- Response time to new target: ~3–5 s (KICKR-class claim). Don't expect the first sample after `0x05` to match.
- Fallback (pre-FTMS firmware only): Wahoo char `A026E005-0A7D-4AB3-97FA-F1500F9FEB8B` on CPS — CCCD `0200`, ERG op `0x42` + uint16 LE watts (GC `Wahoo_Kickr` path). Never drive both control points on one connection.

## Garmin HRM matrix

| Model | BLE | Concurrent BLE | Notes |
|---|---|---|---|
| HRM-Pro / Pro Plus | Yes | 2 | + unlimited ANT+; watch coexists |
| HRM-Dual | Yes | treat as 1 | watch on ANT+ if worn |
| HRM 200 | Yes | — | must be in **Open** (not Secure) pairing mode. Observed 2026-10: first connect from a Mac fails with SMP Pairing Failed reason 5 (Pairing Not Supported) and the link drops; hold the button 4 s (pairing mode, 5 min) and the next attempt bonds. The bond persists; later connects need no button |
| HRM-Run/Tri/Swim | **No** | — | ANT+-only, invisible to Mac |

## ERG loop practice

- Write target on change only; trainer holds last target.
- Global GATT op queue across ALL peripherals (macOS Chrome/noble both serialize; noble has a process-global pending-op) — one read/write in flight process-wide; notifications unaffected.
- Death spiral: trainer physics, not protocol. App guard: cadence < 40 rpm for 5 s ⇒ temporarily drop target to 50 % FTP; restore at ≥ 60 rpm.
- One gear, no shifting in ERG (Cog makes this moot).
- If CP writes fail with insufficient auth/encryption: bond (spec lists Encryption on 0x2AD9); macOS just-works LE usually suffices.
- Dropout: when the trainer link drops or Indoor Bike Data goes stale (> max(3 ticks, 3 s)), the engine pauses the rider (`pauseReason: 'trainer'`) instead of recording 0 W, and resumes on the next fresh sample, re-sending the ERG target.

## Zwift Ride handlebar controllers

Sources (2026-11-18): Makinolo "Zwift Ride protocol" (2024-07-26, Jan 2025 edit); OpenBikeControl/bikecontrol `lib/bluetooth/devices/zwift/{zwift_ride,zwift_device,constants,zwift_unlock}.dart` and issue #3; cagnulein/qdomyos-zwift `src/zwift_play/abstractZapDevice.h`; Custodia-Admin/velo `docs/devices/zwift-ride-v2.md`; support.zwift.com "Using Your Zwift Ride Controller". Not yet checked against Ryan's Ride.

- **Advert.** Both sides advertise as `Zwift Ride` (older firmware: `Zwift SF2`). Manufacturer data: company `0x094A` (`4a 09`), device type (`08` left, `07` right), then the address's last 2 bytes. Connect to the left one only. A connected controller stops advertising and holds one central: quit Zwift first.
- **Service** `FC82` (firmware since Jan 2025) or legacy `00000001-19ca-4651-86e5-fa29dcdd09d1`. Characteristics `0000000X-19ca-4651-86e5-fa29dcdd09d1`: `…02` Async (notify: keypad, battery, idle), `…03` Sync RX (write: commands), `…04` Sync TX (indicate: replies).
- **Handshake.** No encryption (unlike Play / Click v1). Subscribe Async + Sync TX, write ASCII `RideOn` (`52 69 64 65 4f 6e`) to Sync RX; the controller echoes `RideOn` on Sync TX. No app keepalive: the idle controller sends `15` (idle) and `19` (battery, `19 08 55` = 85 %).
- **Keypad** `23` + protobuf `RideKeyPadStatus`: field 1 `ButtonMap` uint32, active-low (a cleared bit is a held button); every frame repeats the held buttons, so act on rising edges only. Paddles ZL/ZR are {location 0/1, sint32 value −100…100} in one of three shapes: field 2 → repeated field 1 (Makinolo's capture), field 2 flat, or repeated field 3 (BikeControl's proto).

| Bit | Button | Bit | Button |
|---|---|---|---|
| `0x0001` | D-pad left | `0x0100` | LS1, left shifter upper |
| `0x0002` | D-pad up | `0x0200` | LS2, left shifter lower |
| `0x0004` | D-pad right | `0x0400` | LB, left drop button |
| `0x0008` | D-pad down | `0x0800` | Left power |
| `0x0010` | A | `0x1000` | RS1, right shifter upper |
| `0x0020` | B | `0x2000` | RS2, right shifter lower |
| `0x0040` | Y | `0x4000` | RB, right drop button |
| `0x0080` | Z | `0x8000` | Right power |

Bits as measured on a Ride (bikecontrol#3, 2025-03-30). Makinolo's `.proto` (Z = `0x100`, every later button one bit up) is wrong. Worked vector: `23 08 fe ff ff ff 0f 12 18 0a 04 08 00 10 00 …` = D-pad left held, paddles at rest.

- **Daily lock (firmware ≥ 1.3, "Ride V2").** The Zwift service is hidden from GATT (or goes quiet) until the Zwift app unlocks it: open Zwift (free account), connect the Ride, press a button, quit Zwift; it then works elsewhere for about 24 h. The driver reads firmware `0x2A26` and names it in that error.
- **openCycle map** (`RIDE_BUTTON_ACTIONS` in `apps/server/src/session/rideControls.ts`): like Zwift's shifting, either right shifter button raises the ERG bias 1 % and either left one lowers it 1 %; A pause/resume, Y twice within 1.5 s skips the step. No button ends a ride. With several riders the presses go to the rider whose trainer matches `OPENCYCLE_ZWIFT_RIDE_TRAINER` (device id or advertised name); without a match they are dropped and logged once. The server links the controller only while a session runs (first rider joins → connect, session ends → disconnect), so Zwift can have it the rest of the time.
