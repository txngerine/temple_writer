# Temple Counter Admin (MERN)

Admin panel and backend for `temple_writing_pad` — the Guruvayur counter app in
the repository root.

The pad is offline-first and self-contained today: SQLite on the device, a
text-file name dictionary, a bundled TFLite model. This service is what turns a
set of independent tablets into something a temple office can see and run:
**an activity log written every day, a record of every login and every sync, and
an offerings rate card the counters pull instead of hardcoding.**

---

## What it plugs into

The app has exactly one remote hook, in `lib/services/sync_service.dart`:

```dart
abstract class SyncService {
  Future<bool> push(List<DevoteeEntry> entries);
}
```

It is implemented by `MockSyncService`, which sleeps and returns `true`. This
backend replaces it. A receipt (`lib/models/devotee_entry.dart`) carries nine
fields — `name`, `nakshatram`, `offering`, `amount`, `addToFavorites`,
`timestamp`, `printed`, `synced`, and a local row id — and already serialises
itself with `toJson()`, ISO-8601 timestamps included.

### Four things the app must change first

These are app-side and they gate everything here. Read
`assets/models/README.md` and the notes in `sqlite_entry_store.dart` before
starting.

| # | Change | Why it blocks |
| - | ------ | ------------- |
| 1 | Receipt UUID generated on the device | `SQLiteEntryStore` keys on `id INTEGER PRIMARY KEY AUTOINCREMENT`, which is per-device — two counters both produce receipt `1`. The UUID is also what makes a retried push idempotent. |
| 2 | A device id + token, provisioned at first launch | Nothing in the app identifies itself. Without it a receipt cannot be attributed, a till cannot be reconciled, and a sync cannot be logged against a counter. |
| 3 | Incremental writes in `SQLiteEntryStore.save()` | It currently does `DELETE FROM entries` then re-inserts every row on every save. That is O(n) writes per receipt, and it churns every primary key — which a sync watermark must never do. |
| 4 | Per-entry acknowledgement instead of `bool` | One bad row fails the whole batch; a timeout after the server committed makes the next push duplicate everything. |

---

## Stack

- **MongoDB** 6+ — primary store
- **Express** 4 — two routers, two audiences (see [API](#api))
- **React** 18 + Vite — admin SPA
- **Node** 20+

```text
admin/
├── server/
│   ├── src/
│   │   ├── models/          # Mongoose schemas
│   │   ├── routes/
│   │   │   ├── device/      # counters authenticate with a device token
│   │   │   └── admin/       # people authenticate with a JWT
│   │   ├── services/
│   │   │   └── activity.js  # the single writer for the activity log
│   │   ├── middleware/      # auth, rbac, request logging
│   │   └── index.js
│   └── package.json
├── web/                     # React admin
│   ├── src/
│   │   ├── pages/           # DailyLog, Offerings, Receipts, Devices, Users
│   │   └── api/
│   └── package.json
└── README.md
```

---

## Getting started

```bash
# server
cd admin/server
npm install
cp .env.example .env          # fill MONGO_URI and JWT_SECRET
npm run seed                  # nakshatrams + offerings (prices left unset)
npm run dev                   # http://localhost:4000

# web
cd admin/web
npm install
npm run dev                   # http://localhost:5173
```

To look at the panel with nothing installed, `npm run dev:memory` in
`admin/server` starts the API on a throwaway in-memory database with the real
offerings and nakshatrams but no counters, receipts or prices; sign in as `admin@temple.test` / `temple-demo`. Nothing is saved.

The first office account is made from the command line, since there is nobody
yet to create it in the panel:

```bash
npm run create-admin -- office@example.org 'a long password'
```

`.env`:

```ini
MONGO_URI=mongodb://127.0.0.1:27017/temple_counter   # or an Atlas mongodb+srv:// string
JWT_SECRET=change-me
PORT=4000
TEMPLE_TZ=Asia/Kolkata        # the day boundary for daily logs — see below
DEVICE_TOKEN_PEPPER=change-me
```

---

## Activity log

The core of this panel. One collection, one writer, everything the counters and
the office do lands in it.

### Schema

```js
// server/src/models/ActivityLog.js
const ActivityLogSchema = new mongoose.Schema({
  day:        { type: String, required: true },   // "2026-09-03", temple-local
  at:         { type: Date,   required: true },   // server receive time, UTC
  occurredAt: { type: Date },                     // device time, when it differs

  type:     { type: String, required: true },     // see the taxonomy below
  severity: { type: String, enum: ['info', 'warning', 'error'], default: 'info' },

  // who
  actorType: { type: String, enum: ['device', 'user', 'system'], required: true },
  deviceId:  { type: String },                    // set for device events
  userId:    { type: mongoose.Types.ObjectId },   // set for office events
  counterName: { type: String },                  // denormalised for reading

  // what
  objectType: { type: String },                   // 'receipt' | 'offering' | ...
  objectId:   { type: String },
  message:    { type: String, required: true },   // human-readable, one line
  meta:       { type: Object },                   // event-specific payload
}, { timestamps: false });

ActivityLogSchema.index({ day: 1, at: -1 });                 // the daily view
ActivityLogSchema.index({ deviceId: 1, at: -1 });
ActivityLogSchema.index({ type: 1, at: -1 });
ActivityLogSchema.index({ objectType: 1, objectId: 1 });
```

**Why `day` is stored and not derived.** The temple's day is
`Asia/Kolkata`, the server may be anywhere, and a tablet's clock drifts. Storing
the day string once — computed from `at` in `TEMPLE_TZ` at write time — makes
"show me today's log" a single indexed lookup instead of a timezone-aware range
scan, and it keeps a receipt written at 00:10 IST on the day the counter was
actually working.

### Event taxonomy

| `type` | Written when | `meta` |
| ------ | ------------ | ------ |
| `app.login` | An operator signs in on a counter | `{ appVersion, modelVersion, platform }` |
| `app.logout` | Operator signs out, or the session expires | `{ reason: 'user' \| 'expiry' }` |
| `device.enrolled` | A tablet is provisioned for the first time | `{ appVersion, enrolledBy }` |
| `device.revoked` | Its token is withdrawn | `{ revokedBy, reason }` |
| `app.sync` | A sync batch finishes | `{ received, accepted, rejected, durationMs, pendingAfter }` |
| `app.sync.failed` | A batch is rejected outright | `{ received, error }` — `severity: 'error'` |
| `receipt.created` | A receipt arrives from a counter | `{ amount, offering, printed }` |
| `receipt.voided` | The office voids one | `{ amount, reason }` — `severity: 'warning'` |
| `offering.created` / `offering.updated` | Rate card changes | `{ before, after }` |
| `dictionary.name.added` / `.updated` | A devotee name is edited | `{ text, section }` |
| `model.published` | A recognition model goes to counters | `{ version, stage, labelCount }` |
| `user.created` / `user.role.changed` | Office accounts change | `{ role, changedBy }` |

**Heartbeats are not activity.** A counter posting its version and pending count
every minute would bury everything above. Keep the last heartbeat on the device
document and log only what changed state.

### Writing to it

One module writes the log, so no route invents its own shape:

```js
// server/src/services/activity.js
import { DateTime } from 'luxon';
import ActivityLog from '../models/ActivityLog.js';

export async function logActivity({
  type, message, actorType, severity = 'info',
  deviceId, userId, counterName, objectType, objectId, occurredAt, meta,
}) {
  const at = new Date();
  const day = DateTime.fromJSDate(at)
    .setZone(process.env.TEMPLE_TZ || 'Asia/Kolkata')
    .toISODate();
  // Never let logging fail the operation it describes: a counter must be able
  // to sync even if the log write does not land.
  try {
    await ActivityLog.create({
      day, at, occurredAt, type, severity, message,
      actorType, deviceId, userId, counterName, objectType, objectId, meta,
    });
  } catch (err) {
    console.error('activity log write failed', type, err.message);
  }
}
```

### Login and sync, specifically

Both are the events the office actually watches, so they get named endpoints
rather than being inferred:

```js
// POST /device/v1/login
await logActivity({
  type: 'app.login',
  actorType: 'device',
  deviceId: device.deviceId,
  counterName: device.counterName,
  message: `${operator.name} signed in at ${device.counterName}`,
  meta: { appVersion, modelVersion, platform },
});

// POST /device/v1/receipts  — after the upsert
await logActivity({
  type: results.rejected.length ? 'app.sync.failed' : 'app.sync',
  severity: results.rejected.length ? 'warning' : 'info',
  actorType: 'device',
  deviceId: device.deviceId,
  counterName: device.counterName,
  message: `Synced ${results.accepted.length} of ${entries.length} receipts`,
  meta: {
    received: entries.length,
    accepted: results.accepted.length,
    rejected: results.rejected.length,
    durationMs, pendingAfter,
  },
});
```

### The daily log page

`web/src/pages/DailyLog.jsx` — a date picker defaulting to today, and one
reverse-chronological list. It reads `GET /admin/logs?day=YYYY-MM-DD`.

Above the list, four counts for the selected day, straight off the same query:
logins, syncs, receipts, and errors. Filters by counter, by actor, and by type.
Group by hour so a shift reads as a shift.

### Retention

Activity rows accumulate at roughly (receipts + syncs + logins) per day and are
cheap. Keep them a year, then let a TTL index drop `info`-severity rows and
retain `warning` and `error`:

```js
// two indexes, because only info rows expire
ActivityLogSchema.index(
  { at: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 365, partialFilterExpression: { severity: 'info' } },
);
```

`receipt.*` events are **not** the receipt itself — receipts live in their own
collection and are financial records. Never expire those.

---

## Offerings and prices

Offerings are `const` lists in `lib/data/suggestions.dart` today, carry an emoji
and **no price**, and the amount is typed by hand on every receipt. Moving them
here is what makes a rate card possible.

### Offering schema

```js
// server/src/models/Offering.js
const OfferingSchema = new mongoose.Schema({
  labelMal: { type: String, required: true, unique: true },  // അർച്ചന
  labelEng: { type: String, required: true },                // Archana
  icon:     { type: String },                                // 🌸, for quick-picks
  price:    { type: Number, min: 0, default: null },          // ₹, null = not set
  priceIsFixed: { type: Boolean, default: true },   // false = devotee-chosen (തുലാഭാരം)
  quickPick:    { type: Boolean, default: false },  // shows on the quick-offerings row
  sortOrder:    { type: Number, default: 100 },
  active:       { type: Boolean, default: false },
  activeFrom:   { type: Date },
  activeTo:     { type: Date },
  updatedBy:    { type: mongoose.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

OfferingSchema.index({ active: 1, sortOrder: 1 });
```

### Rules

- **An offering with `price: null` cannot be `active`.** Enforce it in a
  pre-save hook. A counter that pulls a priced list must never receive an
  offering it cannot charge for.
- **`priceIsFixed: false` means the amount is the devotee's.** തുലാഭാരം is
  weighed and അന്നദാനം is a donation — the pad keeps its free-text amount for
  those, and the panel must not pretend otherwise.
- **Price changes are versioned, not overwritten.** Write the change to the
  activity log with `before`/`after`, so a receipt from last month can be
  explained.
- **Receipts store the amount charged, not a reference to the offering.**
  `DevoteeEntry.amount` is already a value on the receipt. Keep it that way — a
  later price change must not rewrite history.

### Seed

`npm run seed` loads the 19 offerings and 27 nakshatrams that the app currently
hardcodes, taken verbatim from `lib/data/suggestions.dart`:

| Malayalam | English | Quick pick | Price |
| --------- | ------- | ---------- | ----- |
| അർച്ചന | Archana | 🌸 | — |
| പുഷ്പാഞ്ജലി | Pushpanjali | | — |
| ഭാഗ്യസൂക്ത പുഷ്പാഞ്ജലി | Bhagyasooktha Pushpanjali | | — |
| സ്വയംവര പുഷ്പാഞ്ജലി | Swayamvara Pushpanjali | | — |
| നെയ്‍വിളക്ക് | Neyvilakku | 🪔 | — |
| തുലാഭാരം | Thulabharam | ⚖️ | devotee-chosen |
| പാൽപായസം | Palpayasam | 🍯 | — |
| ദീപാരാധന | Deeparadhana | 🔥 | — |
| പ്രസാദം | Prasadam | 🍚 | — |
| അഭിഷേകം | Abhishekam | 💧 | — |
| ഉദയാസ്തമന പൂജ | Udayasthamana Pooja | | — |
| കൃഷ്ണനാട്ടം | Krishnanattam | | — |
| ചോറൂൺ | Choroonu | | — |
| തൃക്കൈവെണ്ണ | Thrikkaivenna | | — |
| മുഴുക്കാപ്പ് | Muzhukkappu | | — |
| നിറമാല | Niramala | | — |
| ഗണപതിഹോമം | Ganapathi Homam | | — |
| അന്നദാനം | Annadanam | | devotee-chosen |
| വിവാഹം | Vivaham | | — |

**Prices ship unset on purpose.** These are the temple's rates and this
repository does not know them — seeding a guess would put a wrong number on a
receipt. Every row seeds `price: null, active: false`; the office enters the
rate card once and the offerings go live as they are priced.

Nakshatrams seed as a separate `nakshatrams` collection (27 rows: `mal`, `eng`,
and traditional order). They have no price and never change; they are master data
only so the app can stop shipping them in Dart.

---

## Other collections

| Collection | Key fields | Notes |
| ---------- | ---------- | ----- |
| `receipts` | `_id` = device UUID, `deviceId`, `name`, `nakshatram`, `offering`, `amount`, `occurredAt`, `receivedAt`, `printed`, `voided` | Upsert on `_id`. Financial record — never expires, never hard-deleted. |
| `devices` | `deviceId`, `counterName`, `tokenHash`, `appVersion`, `modelVersion`, `lastSeenAt`, `pendingCount` | Heartbeat target. One row per tablet. |
| `users` | `email`, `passwordHash`, `role`, `active` | Roles: `admin`, `supervisor`, `operator`, `ml`. |
| `nakshatrams` | `mal`, `eng`, `order` | 27 rows, seeded, effectively read-only. |
| `names` | `text`, `section`, `active`, `receiptCount` | The devotee dictionary, if you take it off the text file. Enforce the chillu rule: `രാജൻ`, never `രാജന്`. |

---

## API

Two routers on one app. Devices are unattended and retry blindly, so every
device route must be safe to call twice.

### Device routes — `Authorization: Device <token>`

| Route | Does |
| ----- | ---- |
| `POST /device/v1/enroll` | One-time provisioning; returns `deviceId` + token. Logs `device.enrolled`. |
| `POST /device/v1/login` | Operator sign-in at a counter. Logs `app.login`. |
| `POST /device/v1/logout` | Logs `app.logout`. |
| `POST /device/v1/receipts` | Bulk upsert keyed on receipt UUID. Returns `[{ id, status }]`. Logs `app.sync`. |
| `GET /device/v1/master?since=` | Offerings (active + priced), nakshatrams, dictionary delta. |
| `POST /device/v1/heartbeat` | Version + pending count. Updates `devices`, writes no activity row. |

### Admin routes — `Authorization: Bearer <jwt>`

| Route | Does |
| ----- | ---- |
| `GET /admin/logs?day=&type=&deviceId=` | The daily log. Defaults to today in `TEMPLE_TZ`. |
| `GET /admin/logs/summary?day=` | Counts per type for the day tiles. |
| `GET /admin/offerings` · `POST` · `PATCH /:id` | Rate card. Every write logs before/after. |
| `GET /admin/receipts` · `POST /:id/void` | Search and void. Voiding logs at `warning`. |
| `GET /admin/reports/daily?day=` | Collection totals by offering and by counter. |
| `GET /admin/devices` · `POST /:id/revoke` | Registry. |
| `/admin/users` | Accounts and roles. |

---

## As built

`admin/server` and `admin/web` exist and follow this document. Where it was
silent, these are the choices made:

- **Enrolment needs a code from the office.** `POST /admin/devices` (admin
  only) registers a counter and returns a one-time code; the tablet sends it to
  `POST /device/v1/enroll` to get its token. Calling enrol again issues a new
  token, and the code stops working the first time the token is used.
- **A devotee-chosen offering may be active with no price.** The "no price, not
  active" rule binds only `priceIsFixed: true` rows; otherwise തുലാഭാരം and
  അന്നദാനം could never reach a counter.
- **A pushed receipt is insert-only.** A re-push answers `duplicate` and changes
  nothing, so it cannot un-void a receipt. Statuses: `created`, `duplicate`,
  `rejected` (with `error`).
- **Receipts carry their temple-local `day`**, taken from the device timestamp,
  which is what the daily report groups on. Voided receipts are left out of the
  totals and shown separately.
- **Roles.** Any signed-in account can read. Changing offerings and voiding
  receipts needs `admin` or `supervisor`; counters and users need `admin`.
- **Not built:** a panel page for the `names` dictionary and anything for
  `model.published`. The `names` collection and its chillu rule exist, and
  `GET /device/v1/master` returns it.

The Flutter app does not talk to this server yet: step 1 below is still open.

---

## Build order

1. **Identity and real sync** — enrolment, receipt UUIDs, per-entry ack, and an
   HTTP `SyncService` in the Flutter app replacing `MockSyncService`. Nothing
   else works before this.
2. **Activity log** — the collection, the `logActivity` writer, `app.login` and
   `app.sync`, and the daily log page. This is the first thing the office can
   actually use.
3. **Offerings and prices** — schema, seed, rate-card UI, and the
   `GET /device/v1/master` pull so counters stop hardcoding the list.
4. **Receipts, reports, devices, users, audit.**

---

## One warning worth carrying over

If this backend ever needs to turn handwriting strokes into training images, **do
not re-implement `StrokeRenderer` in JavaScript.** `assets/models/README.md`
records that the renderer measuring a drawing differently from the training
pipeline was the single largest source of wrong answers, and it has recurred
since. Invoke the Dart renderer (`tool/dart/render_pad_training_set.dart`) as a
worker instead. Same for training: it is Python, and Node's job is to enqueue it.
