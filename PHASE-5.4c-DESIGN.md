# HomeHub V5 — Phase 5.4c Design: Custom Cleaning Templates and AI Routine Import

**Baseline:** v5.8.1 (Phase 5.4b): 290/290 unit + static, 112/112 browser, 119 emulator tests. The v5.8.1 ZIP was not re-attached, so the delivered v5.8.1 package was used (the only v5.8.1 build).

## 1. Audit summary

- **Built-in suggestions** (5.3.1–5.4b):
  - extracted library (6 room types / 35 tasks; 7 device types / 70 tasks, 66 generatable);
  - deterministic ids `r_<room>_<key>` / `d_<device>_<key>`;
  - review → confirm; archived tombstones; one confirmed write per task;
  - **no revision mechanism and no household override collection** exists in HomeHub.
- **Task schema:**
  - manual tasks have an exact key set plus an optional immutable `trigger`;
  - generated tasks add `source` and `estimatedMinutes`;
  - recurrence kinds: `once`, `days`, `weeks`, `months`, `after`, `onUse`, `onSeason`;
  - triggers: `afterUse`, `seasonal` (`active` / `start` / `end`) on an active device of the same Home.
- **The standalone app** had household template overrides (`roomTypes` / `deviceTypes` under `hr_homes`) and a "personal routine package" JSON import: validate → normalise (whitelist) → map types to real rooms/devices → confirm.
  - Its prompt **automatically** included room and device names; HomeHub does not.
- **Needed:** one new narrowly scoped collection, plus two optional, immutable or validated fields on manual tasks. No other schema changes; no migration.

## 2. Schema

### 2.1 `homes/{h}/cleaningCustomTemplates/{templateId}` (new)

A template is **one reusable task definition**. Definitions sharing a `pack` name form a set that can be applied together, like a standalone room type.

> **Modelling decision.** I deliberately did **not** store a template as one document holding an array of tasks: Firestore rules cannot iterate an array, so array elements could not be validated. With one definition per document, the rules validate every field exactly.

| Field | Rule |
|---|---|
| `pack` | string 1–60 (e.g. "Kitchen deep clean") |
| `title` | 1–120; `titleEn` null or 1–120; `instructions` null or ≤ 1000 |
| `minutes` | int 1–600; `priority`: low / normal / high |
| `target` | `room` \| `device` \| `home` (chosen when applying) |
| `recurrence` | any existing kind **except `once`** (a template has no dates), validated by the existing `cleanRecurrenceOk` |
| `trigger` | null, `{kind: 'afterUse'}`, or `{kind: 'seasonal', phase}`. The device is chosen when applying; target must be `device`; phase/recurrence consistency is the same as for tasks. |
| `active`, `archivedAt`, `archivedBy` | archive / reactivate only (**no delete**) |
| `rev` | +1 on every update, so a concurrent edit is refused instead of lost |
| audit / identity | `createdBy`, `createdAt` (immutable); `updatedBy`, `updatedAt`; `schemaVersion: 1`. Id: `^[A-Za-z0-9_]{6,60}$`. |

### 2.2 `cleaningTasks` (existing): two optional fields

| Field | Purpose |
|---|---|
| `templateRef` | `{templateId, rev}`, **immutable**. The task id **must equal** `c_<templateId>_<target>`, where target = the trigger's device id, else the room id, else `home`. The template must exist in **this** Home and be active. |
| `estimatedMinutes` | Now also allowed on manual tasks (1–600). It was already editable. |

**Backward compatibility:** older tasks, without these fields, are unchanged and valid.

## 3. Idempotency and concurrency

| Write | Id | Effect |
|---|---|---|
| Apply a custom template | `c_<templateId>_<target>` | The same template on the same room/device can exist once. Repeat, retry, or a second member gets "already exists", which counts as a duplicate, not a failure. An archived (declined) task with that id blocks re-creation. |
| AI-imported task | `ai_<hash>` | A 64-bit FNV-1a hash of the normalised content and target. A retry, refresh or concurrent import of the same item → the same id → already exists. |
| AI-imported template | `ai_<hash>` (same scheme) | — |
| Template edit | `rev` n → n+1 | A stale editor is refused, then sees the latest version |

All writes are **one document per request**, with confirmed progress and honest partial results (the v5.7.2 pattern). Success is never shown before server confirmation.

## 4. AI import: JSON contract (v1)

```json
{
  "schemaVersion": 1,
  "packageType": "homehub-cleaning-plan",
  "metadata": { "name": "Kitchen reset", "language": "ar" },
  "tasks": [
    { "title": "مسح سطح المطبخ", "titleEn": "Wipe the counter", "areaType": "kitchen",
      "frequency": { "type": "daily" }, "estimatedMinutes": 5, "priority": "normal", "note": "", "reason": "" }
  ],
  "templates": [
    { "pack": "Weekend", "title": "تنظيف الثلاجة", "deviceType": "fridge", "triggerType": "periodic",
      "frequency": { "type": "interval", "unit": "month", "n": 1 }, "estimatedMinutes": 20 }
  ]
}
```

- **`packageType`:** `homehub-cleaning-plan`. The standalone `personal-routine` is also accepted, with the same task shape.
- **`areaType`** ∈ the standalone room types (bedroom, kitchen, bathroom, living, entrance, balcony) **or** HomeHub room types. **`deviceType`** ∈ the standalone device types **or** HomeHub subtypes.
  - Each item names **exactly one** of `areaType` / `deviceType`.
  - Items are mapped to the household's **actual** rooms and devices in the preview: auto-matched by type, and the user can change it.
- **`frequency`:** as in the standalone app (`daily`; `interval {unit, n}`; `weekly {weekday}`; `monthly {day}`).
- **`triggerType`** (device items only):
  - **supported:** `periodic`, `afterUse`, `afterCycle`, `seasonStart`, `seasonEnd`, `inSeason`;
  - **unsupported:** `conditionBased`, `manual`, which are reported as invalid.
- **Limits:**
  - JSON ≤ 100 KB; nesting depth ≤ 6; ≤ 100 tasks; ≤ 50 templates;
  - titles ≤ 120; notes / reasons ≤ 300; minutes 1–240 (the standalone limit);
  - unknown keys → item invalid.
- **Rejected:**
  - `__proto__` / `constructor` / `prototype` keys anywhere;
  - any `id`, `homeId`, `uid`, `createdBy`, path or date fields (they are not in the whitelist);
  - URLs (`http(s)://`, `www.`) in text;
  - control characters.

**Parsing:** `JSON.parse` only; no `eval` and no HTML insertion. All text is rendered with `textContent`.

## 5. Prompt privacy model

- The prompt is composed **locally** from what the user **ticks**:
  - room types or their names (names are off by default);
  - device types;
  - minutes per day, preferred frequency style, language;
  - free-text "problems" that the user types themselves.
- **Never included:** member names, emails, finances, savings, Zakat, notes, ids.
- The app makes **no network call**. The user copies the prompt into an AI tool of their choice.
- Raw prompts and pasted JSON are **not stored**. Only validated, user-confirmed tasks and templates are written.

## 6. Access matrix (existing permissions)

| Action | Owner / Admin | Member | Child | Viewer | Other Home |
|---|---|---|---|---|---|
| View templates | ✔ | ✔ | ✔ | ✔ | ✘ |
| Create / edit / archive / reactivate / duplicate templates (`cleaning.edit`) | ✔ | ✔ | ✘ | ✘ | ✘ |
| Apply templates / import tasks (`cleaning.create`) | ✔ | ✔ | ✘ | ✘ | ✘ |
| Import templates (`cleaning.edit`) | ✔ | ✔ | ✘ | ✘ | ✘ |

## 7. Limitations (by design)

- A device-targeted template **requires a device trigger** (after-use or seasonal). Plain periodic device maintenance uses a room- or home-targeted template, because HomeHub tasks have no non-trigger device link.
- **Editing a template never changes tasks already created from it.** Those are ordinary tasks, edited individually.
- **Built-in suggestions are not editable.** A built-in can be **duplicated into a custom template**, which is then edited.
- The `conditionBased` and `manual` triggers remain unsupported.
