/**
 * Built-in cleaning template libraries — GENERATED from the standalone Cleaning app (homeCleaning.html)
 * by evaluating its TEMPLATES / TEMPLATES_EN / DEVICE_TEMPLATES / DEVICE_NAMES_EN / DEVICE_TASKS_EN /
 * PRI_MAP literals (Phase 5.3.1). Do not edit by hand: keys, titles and frequencies must stay identical.
 *
 * Stable keys: room tasks `<roomType>_<index>` (standalone: `${T.key}_${i}`); device tasks keep the
 * standalone key (`x.k`, unique within its device type).
 * freq: { unit: 'day' | 'month', n } — LAST-COMPLETION based (standalone nextAfter semantics).
 * generate: false → deferred to a later phase (seasonal device, usage / cycle / condition / manual
 * trigger, or season start/end item); key and metadata are preserved here unchanged.
 */
export const TEMPLATE_VERSION = 1;
export const ROOM_TEMPLATES = Object.freeze([
 {
  "key": "bedroom",
  "icon": "🛏️",
  "nameAr": "غرفة النوم",
  "nameEn": "Bedroom",
  "tasks": [
   {
    "key": "bedroom_0",
    "titleAr": "ترتيب السرير",
    "titleEn": "Make the bed",
    "freq": {
     "unit": "day",
     "n": 1
    },
    "minutes": 2,
    "priority": "normal",
    "noteAr": "رتّب السرير وافتح الشباك للتهوية.",
    "generate": true
   },
   {
    "key": "bedroom_1",
    "titleAr": "لمّ الهدوم من الأرض",
    "titleEn": "Pick clothes up off the floor",
    "freq": {
     "unit": "day",
     "n": 1
    },
    "minutes": 3,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bedroom_2",
    "titleAr": "شيل الأكواب والأطباق من الغرفة",
    "titleEn": "Take cups & plates out of the room",
    "freq": {
     "unit": "day",
     "n": 1
    },
    "minutes": 2,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bedroom_3",
    "titleAr": "تغيير ملايات السرير",
    "titleEn": "Change the bed sheets",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 10,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bedroom_4",
    "titleAr": "مسح الأتربة",
    "titleEn": "Dust surfaces",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 8,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bedroom_5",
    "titleAr": "كنس وموب الأرضية",
    "titleEn": "Vacuum & mop the floor",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 12,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bedroom_6",
    "titleAr": "تنضيف تحت السرير",
    "titleEn": "Clean under the bed",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 10,
    "priority": "low",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bedroom_7",
    "titleAr": "ترتيب الدولاب",
    "titleEn": "Organize the wardrobe",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 20,
    "priority": "low",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bedroom_8",
    "titleAr": "تنضيف فلاتر التكييف",
    "titleEn": "Clean the AC filters",
    "freq": {
     "unit": "month",
     "n": 3
    },
    "minutes": 20,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   }
  ]
 },
 {
  "key": "kitchen",
  "icon": "🍳",
  "nameAr": "المطبخ",
  "nameEn": "Kitchen",
  "tasks": [
   {
    "key": "kitchen_0",
    "titleAr": "غسيل الأطباق",
    "titleEn": "Wash the dishes",
    "freq": {
     "unit": "day",
     "n": 1
    },
    "minutes": 10,
    "priority": "high",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "kitchen_1",
    "titleAr": "مسح الرخامة",
    "titleEn": "Wipe the counter",
    "freq": {
     "unit": "day",
     "n": 1
    },
    "minutes": 5,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "kitchen_2",
    "titleAr": "تنضيف الحوض",
    "titleEn": "Clean the sink",
    "freq": {
     "unit": "day",
     "n": 1
    },
    "minutes": 3,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "kitchen_3",
    "titleAr": "مسح البوتاجاز",
    "titleEn": "Wipe the stovetop",
    "freq": {
     "unit": "day",
     "n": 1
    },
    "minutes": 4,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "kitchen_4",
    "titleAr": "إخراج الزبالة",
    "titleEn": "Take out the trash",
    "freq": {
     "unit": "day",
     "n": 1
    },
    "minutes": 2,
    "priority": "high",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "kitchen_5",
    "titleAr": "تنضيف البوتاجاز بعمق",
    "titleEn": "Deep-clean the stovetop",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 15,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "kitchen_6",
    "titleAr": "تنضيف الميكروويف",
    "titleEn": "Clean the microwave",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 5,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "kitchen_7",
    "titleAr": "مسح مقابض الدواليب",
    "titleEn": "Wipe cabinet handles",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 4,
    "priority": "low",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "kitchen_8",
    "titleAr": "موب أرضية المطبخ",
    "titleEn": "Mop the kitchen floor",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 8,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "kitchen_9",
    "titleAr": "تنضيف الثلاجة",
    "titleEn": "Clean the fridge",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 15,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "kitchen_10",
    "titleAr": "تنضيف الدواليب من جوه",
    "titleEn": "Clean inside the cabinets",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 20,
    "priority": "low",
    "noteAr": null,
    "generate": true
   }
  ]
 },
 {
  "key": "bathroom",
  "icon": "🚿",
  "nameAr": "الحمام",
  "nameEn": "Bathroom",
  "tasks": [
   {
    "key": "bathroom_0",
    "titleAr": "ترتيب الحوض بسرعة",
    "titleEn": "Quick sink tidy-up",
    "freq": {
     "unit": "day",
     "n": 1
    },
    "minutes": 2,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bathroom_1",
    "titleAr": "تعليق المناشف",
    "titleEn": "Hang up the towels",
    "freq": {
     "unit": "day",
     "n": 1
    },
    "minutes": 1,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bathroom_2",
    "titleAr": "تنضيف التواليت",
    "titleEn": "Clean the toilet",
    "freq": {
     "unit": "day",
     "n": 3
    },
    "minutes": 5,
    "priority": "high",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bathroom_3",
    "titleAr": "تنضيف الحوض",
    "titleEn": "Clean the sink",
    "freq": {
     "unit": "day",
     "n": 3
    },
    "minutes": 4,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bathroom_4",
    "titleAr": "تنضيف الدش",
    "titleEn": "Clean the shower",
    "freq": {
     "unit": "day",
     "n": 3
    },
    "minutes": 6,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "bathroom_5",
    "titleAr": "تنضيف الحمام بعمق",
    "titleEn": "Deep-clean the bathroom",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 20,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   }
  ]
 },
 {
  "key": "living",
  "icon": "🛋️",
  "nameAr": "غرفة المعيشة",
  "nameEn": "Living Room",
  "tasks": [
   {
    "key": "living_0",
    "titleAr": "ترتيب الصالة",
    "titleEn": "Tidy up the living room",
    "freq": {
     "unit": "day",
     "n": 1
    },
    "minutes": 5,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "living_1",
    "titleAr": "مكنسة الأرضية",
    "titleEn": "Vacuum the floor",
    "freq": {
     "unit": "day",
     "n": 3
    },
    "minutes": 10,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "living_2",
    "titleAr": "مسح الأتربة",
    "titleEn": "Dust surfaces",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 10,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "living_3",
    "titleAr": "موب الأرضية",
    "titleEn": "Mop the floor",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 12,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "living_4",
    "titleAr": "تنضيف الشبابيك والزجاج",
    "titleEn": "Clean the windows & glass",
    "freq": {
     "unit": "month",
     "n": 2
    },
    "minutes": 20,
    "priority": "low",
    "noteAr": null,
    "generate": true
   }
  ]
 },
 {
  "key": "entrance",
  "icon": "🚪",
  "nameAr": "المدخل",
  "nameEn": "Entrance",
  "tasks": [
   {
    "key": "entrance_0",
    "titleAr": "ترتيب الجزم",
    "titleEn": "Arrange the shoes",
    "freq": {
     "unit": "day",
     "n": 2
    },
    "minutes": 3,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "entrance_1",
    "titleAr": "مسح أرضية المدخل",
    "titleEn": "Wipe the entrance floor",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 5,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   }
  ]
 },
 {
  "key": "balcony",
  "icon": "🌿",
  "nameAr": "البلكونة",
  "nameEn": "Balcony",
  "tasks": [
   {
    "key": "balcony_0",
    "titleAr": "ري النباتات",
    "titleEn": "Water the plants",
    "freq": {
     "unit": "day",
     "n": 2
    },
    "minutes": 3,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   },
   {
    "key": "balcony_1",
    "titleAr": "كنس البلكونة",
    "titleEn": "Sweep the balcony",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 8,
    "priority": "normal",
    "noteAr": null,
    "generate": true
   }
  ]
 }
]);
export const DEVICE_TEMPLATES = Object.freeze([
 {
  "key": "ac",
  "icon": "❄️",
  "nameAr": "تكييف",
  "nameEn": "Air Conditioner",
  "mode": "seasonal",
  "tasks": [
   {
    "key": "f_clean",
    "titleAr": "تنضيف الفلاتر",
    "titleEn": "Clean the filters",
    "phase": "start",
    "trigger": "manual",
    "freq": null,
    "minutes": 10,
    "priority": "high",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "ind_clean",
    "titleAr": "تنضيف السطح الظاهر للوحدة الداخلية",
    "titleEn": "Wipe the indoor unit's visible surface",
    "phase": "start",
    "trigger": "manual",
    "freq": null,
    "minutes": 8,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "vents_clean",
    "titleAr": "تنضيف فتحات الهواء",
    "titleEn": "Clean the air vents",
    "phase": "start",
    "trigger": "manual",
    "freq": null,
    "minutes": 5,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "out_check",
    "titleAr": "فحص الوحدة الخارجية شكليًا",
    "titleEn": "Visually check the outdoor unit",
    "phase": "start",
    "trigger": "manual",
    "freq": null,
    "minutes": 5,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "drain_check",
    "titleAr": "فحص مسار الصرف الظاهر",
    "titleEn": "Check the visible drain path",
    "phase": "start",
    "trigger": "manual",
    "freq": null,
    "minutes": 3,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "test_run",
    "titleAr": "تشغيل وتجربة الوحدة",
    "titleEn": "Run and test the unit",
    "phase": "start",
    "trigger": "manual",
    "freq": null,
    "minutes": 10,
    "priority": "high",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "leak_check",
    "titleAr": "فحص أي تسريب مياه ظاهر",
    "titleEn": "Check for any visible water leak",
    "phase": "start",
    "trigger": "manual",
    "freq": null,
    "minutes": 3,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "noise_log",
    "titleAr": "تسجيل أي صوت أو أداء غير طبيعي",
    "titleEn": "Note any unusual sound or performance",
    "phase": "start",
    "trigger": "manual",
    "freq": null,
    "minutes": 2,
    "priority": "low",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "f_periodic",
    "titleAr": "تنضيف الفلاتر",
    "titleEn": "Clean the filters",
    "phase": "active",
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 14
    },
    "minutes": 10,
    "priority": "high",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "visual_insp",
    "titleAr": "فحص ظاهري دوري",
    "titleEn": "Routine visual check",
    "phase": "active",
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 14
    },
    "minutes": 5,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "vents_periodic",
    "titleAr": "تنضيف فتحات الهواء",
    "titleEn": "Clean the air vents",
    "phase": "active",
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 5,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "out_periodic",
    "titleAr": "تنضيف الوحدة الخارجية حسب الإمكانية",
    "titleEn": "Clean the outdoor unit where reachable",
    "phase": "active",
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 2
    },
    "minutes": 15,
    "priority": "low",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "f_end",
    "titleAr": "تنضيف الفلاتر",
    "titleEn": "Clean the filters",
    "phase": "end",
    "trigger": "manual",
    "freq": null,
    "minutes": 10,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "surf_end",
    "titleAr": "تنضيف السطح الظاهر",
    "titleEn": "Wipe the visible surface",
    "phase": "end",
    "trigger": "manual",
    "freq": null,
    "minutes": 8,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "moist_end",
    "titleAr": "فحص أي رطوبة أو مياه",
    "titleEn": "Check for any moisture or water",
    "phase": "end",
    "trigger": "manual",
    "freq": null,
    "minutes": 3,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   },
   {
    "key": "prep_end",
    "titleAr": "تجهيز الوحدة لفترة التوقف",
    "titleEn": "Prep the unit for the off-season",
    "phase": "end",
    "trigger": "manual",
    "freq": null,
    "minutes": 5,
    "priority": "low",
    "noteAr": null,
    "generate": false,
    "deferredReason": "seasonal-device"
   }
  ]
 },
 {
  "key": "dishwasher",
  "icon": "🍽️",
  "nameAr": "غسالة أطباق",
  "nameEn": "Dishwasher",
  "mode": "alwaysActive",
  "tasks": [
   {
    "key": "after_food",
    "titleAr": "إزالة بقايا الطعام الظاهرة",
    "titleEn": "Remove visible food residue",
    "phase": null,
    "trigger": "afterCycle",
    "freq": null,
    "minutes": 2,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterCycle"
   },
   {
    "key": "after_door",
    "titleAr": "ترك الباب مفتوح شوية لو مناسب للجهاز",
    "titleEn": "Leave the door ajar if suitable for the unit",
    "phase": null,
    "trigger": "afterCycle",
    "freq": null,
    "minutes": 1,
    "priority": "low",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterCycle"
   },
   {
    "key": "w_filter",
    "titleAr": "تنضيف الفلتر",
    "titleEn": "Clean the filter",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 8,
    "priority": "high",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "w_spray",
    "titleAr": "فحص وتنضيف فتحات ذراع الرش",
    "titleEn": "Check & clean the spray-arm holes",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 6,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "w_gasket",
    "titleAr": "تنضيف حلقة الباب والحواف",
    "titleEn": "Clean the door gasket & edges",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 5,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "m_cycle",
    "titleAr": "تشغيل دورة تنضيف داخلية مناسبة",
    "titleEn": "Run a suitable internal cleaning cycle",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 15,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "m_edges",
    "titleAr": "تنضيف الحواف الداخلية",
    "titleEn": "Clean the interior edges",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 8,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "descale",
    "titleAr": "إزالة الترسبات عند الحاجة",
    "titleEn": "Descale when needed",
    "phase": null,
    "trigger": "conditionBased",
    "freq": null,
    "minutes": 15,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:conditionBased"
   }
  ]
 },
 {
  "key": "fridge",
  "icon": "🧊",
  "nameAr": "الثلاجة",
  "nameEn": "Fridge",
  "mode": "alwaysActive",
  "tasks": [
   {
    "key": "spoiled",
    "titleAr": "شيل أي أكل فاسد أو منتهي",
    "titleEn": "Remove any spoiled or expired food",
    "phase": null,
    "trigger": "manual",
    "freq": null,
    "minutes": 3,
    "priority": "high",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:manual"
   },
   {
    "key": "spill",
    "titleAr": "نضّف أي انسكاب فورًا",
    "titleEn": "Clean up any spill right away",
    "phase": null,
    "trigger": "manual",
    "freq": null,
    "minutes": 2,
    "priority": "high",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:manual"
   },
   {
    "key": "door_check",
    "titleAr": "اتأكد إن الباب بيتقفل صح",
    "titleEn": "Make sure the door seals properly",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 1,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "review",
    "titleAr": "راجع المحتويات",
    "titleEn": "Review the contents",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 5,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "shelves_w",
    "titleAr": "تنضيف الأرفف المتّسخة",
    "titleEn": "Clean dirty shelves",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 8,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "handle",
    "titleAr": "تنضيف المقبض",
    "titleEn": "Clean the handle",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 1,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "shelves_m",
    "titleAr": "تنضيف الأرفف والأدراج بعمق",
    "titleEn": "Deep-clean shelves & drawers",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 20,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "gasket_m",
    "titleAr": "تنضيف حلقة الباب",
    "titleEn": "Clean the door gasket",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 6,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "ext_m",
    "titleAr": "تنضيف السطح الخارجي",
    "titleEn": "Clean the exterior surface",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 8,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "rear",
    "titleAr": "تنضيف الخلفية/الأسفل لو آمن",
    "titleEn": "Clean the back/underside if safe to do so",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 4
    },
    "minutes": 15,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "gasket_insp",
    "titleAr": "فحص حلقة الباب",
    "titleEn": "Inspect the door gasket",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 4
    },
    "minutes": 3,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   }
  ]
 },
 {
  "key": "airfryer",
  "icon": "🍟",
  "nameAr": "قلاية هوائية",
  "nameEn": "Air Fryer",
  "mode": "alwaysActive",
  "tasks": [
   {
    "key": "af_residue",
    "titleAr": "إزالة بقايا الطعام",
    "titleEn": "Remove food residue",
    "phase": null,
    "trigger": "afterUse",
    "freq": null,
    "minutes": 3,
    "priority": "high",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterUse"
   },
   {
    "key": "af_basket",
    "titleAr": "تنضيف السلة",
    "titleEn": "Clean the basket",
    "phase": null,
    "trigger": "afterUse",
    "freq": null,
    "minutes": 4,
    "priority": "high",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterUse"
   },
   {
    "key": "af_drawer",
    "titleAr": "تنضيف الدرج",
    "titleEn": "Clean the drawer",
    "phase": null,
    "trigger": "afterUse",
    "freq": null,
    "minutes": 3,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterUse"
   },
   {
    "key": "af_interior",
    "titleAr": "مسح الداخل عند الحاجة",
    "titleEn": "Wipe the interior when needed",
    "phase": null,
    "trigger": "afterUse",
    "freq": null,
    "minutes": 2,
    "priority": "low",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterUse"
   },
   {
    "key": "af_deep_basket",
    "titleAr": "تنضيف أعمق للسلة",
    "titleEn": "Deep-clean the basket",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 10,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "af_interior_w",
    "titleAr": "تنضيف الداخل أسبوعيًا",
    "titleEn": "Clean the interior weekly",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 8,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "af_ext_w",
    "titleAr": "تنضيف السطح الخارجي",
    "titleEn": "Clean the exterior surface",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 4,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "af_element",
    "titleAr": "تنضيف حوالين عنصر التسخين حسب تعليمات الشركة",
    "titleEn": "Clean around the heating element per manufacturer instructions",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 10,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "af_coating",
    "titleAr": "فحص السلة والطبقة الداخلية",
    "titleEn": "Check the basket & interior coating",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 3,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   }
  ]
 },
 {
  "key": "vacuum",
  "icon": "🧹",
  "nameAr": "مكنسة كهربائية",
  "nameEn": "Vacuum Cleaner",
  "mode": "alwaysActive",
  "tasks": [
   {
    "key": "v_empty",
    "titleAr": "تفريغ الحاوية لو محتاجة",
    "titleEn": "Empty the bin if needed",
    "phase": null,
    "trigger": "afterUse",
    "freq": null,
    "minutes": 2,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterUse"
   },
   {
    "key": "v_hair",
    "titleAr": "شيل الشعر والخيوط من الفرشة",
    "titleEn": "Remove hair & thread from the brush",
    "phase": null,
    "trigger": "afterUse",
    "freq": null,
    "minutes": 3,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterUse"
   },
   {
    "key": "v_brush_w",
    "titleAr": "تنضيف الفرشة الرئيسية",
    "titleEn": "Clean the main brush",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 6,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "v_attach",
    "titleAr": "تنضيف الملحقات",
    "titleEn": "Clean the attachments",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 5,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "v_hose_w",
    "titleAr": "فحص الخرطوم/الأنبوب",
    "titleEn": "Check the hose/tube",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 3,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "v_filter_m",
    "titleAr": "تنضيف الفلاتر حسب نوعها وتعليمات الشركة",
    "titleEn": "Clean the filters per type & manufacturer instructions",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 10,
    "priority": "high",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "v_wheels_m",
    "titleAr": "فحص الفرشة والعجل",
    "titleEn": "Check the brush & wheels",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 5,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "v_hose_m",
    "titleAr": "فحص الخرطوم",
    "titleEn": "Check the hose",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 3,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "v_full",
    "titleAr": "تفريغ الحاوية لما تبقى ممتلئة",
    "titleEn": "Empty the bin once full",
    "phase": null,
    "trigger": "conditionBased",
    "freq": null,
    "minutes": 2,
    "priority": "high",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:conditionBased"
   }
  ]
 },
 {
  "key": "microwave",
  "icon": "📻",
  "nameAr": "ميكروويف",
  "nameEn": "Microwave",
  "mode": "alwaysActive",
  "tasks": [
   {
    "key": "mw_spill",
    "titleAr": "مسح أي انسكاب",
    "titleEn": "Wipe up any spill",
    "phase": null,
    "trigger": "afterUse",
    "freq": null,
    "minutes": 2,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterUse"
   },
   {
    "key": "mw_turntable",
    "titleAr": "تنضيف الطبق الدوار",
    "titleEn": "Clean the turntable",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 4,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "mw_walls",
    "titleAr": "تنضيف الحوائط الداخلية",
    "titleEn": "Clean the interior walls",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 5,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "mw_door",
    "titleAr": "تنضيف الباب والمقبض",
    "titleEn": "Clean the door & handle",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 3,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "mw_ext",
    "titleAr": "تنضيف السطح الخارجي",
    "titleEn": "Clean the exterior surface",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 3,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "mw_deep",
    "titleAr": "تنضيف داخلي أعمق",
    "titleEn": "Deep-clean the interior",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 12,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "mw_vent",
    "titleAr": "تنضيف الأتربة حوالين فتحات التهوية",
    "titleEn": "Clean dust around the vents",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 5,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   }
  ]
 },
 {
  "key": "stove",
  "icon": "🔥",
  "nameAr": "البوتاجاز",
  "nameEn": "Stovetop",
  "mode": "alwaysActive",
  "tasks": [
   {
    "key": "st_residue",
    "titleAr": "إزالة بقايا الطعام",
    "titleEn": "Remove food residue",
    "phase": null,
    "trigger": "afterUse",
    "freq": null,
    "minutes": 3,
    "priority": "high",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterUse"
   },
   {
    "key": "st_surface",
    "titleAr": "مسح السطح",
    "titleEn": "Wipe the surface",
    "phase": null,
    "trigger": "afterUse",
    "freq": null,
    "minutes": 2,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterUse"
   },
   {
    "key": "st_spill",
    "titleAr": "تنضيف أي انسكاب",
    "titleEn": "Clean up any spill",
    "phase": null,
    "trigger": "afterUse",
    "freq": null,
    "minutes": 2,
    "priority": "normal",
    "noteAr": null,
    "generate": false,
    "deferredReason": "trigger:afterUse"
   },
   {
    "key": "st_grates",
    "titleAr": "تنضيف الشبكات",
    "titleEn": "Clean the grates",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 8,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "st_burners",
    "titleAr": "تنضيف رؤوس الشعلة حسب تصميم الجهاز",
    "titleEn": "Clean the burner heads per the unit's design",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 8,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "st_knobs",
    "titleAr": "تنضيف المفاتيح",
    "titleEn": "Clean the knobs",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 4,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "st_around",
    "titleAr": "تنضيف حوالين الشعلات",
    "titleEn": "Clean around the burners",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "day",
     "n": 7
    },
    "minutes": 5,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "st_deep",
    "titleAr": "تنضيف أعمق للسطح",
    "titleEn": "Deep-clean the surface",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 15,
    "priority": "normal",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "st_hard",
    "titleAr": "تنضيف الأماكن صعبة الوصول الظاهرة",
    "titleEn": "Clean the visible hard-to-reach spots",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 1
    },
    "minutes": 10,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   },
   {
    "key": "st_visual",
    "titleAr": "فحص ظاهري للأجزاء الخارجية — الصيانة الفنية عند فني مؤهّل فقط",
    "titleEn": "Visual check of external parts — technical servicing by a qualified technician only",
    "phase": null,
    "trigger": "periodic",
    "freq": {
     "unit": "month",
     "n": 2
    },
    "minutes": 3,
    "priority": "low",
    "noteAr": null,
    "generate": true,
    "deferredReason": null
   }
  ]
 }
]);
