# Cleaning Template Inventory (Phase 5.3.1)

Extracted from **homeCleaning.html** by evaluating its `TEMPLATES`, `TEMPLATES_EN`, `DEVICE_TEMPLATES`, `DEVICE_NAMES_EN`, `DEVICE_TASKS_EN` and `PRI_MAP` literals. **Template version:** 1. A unit test re-extracts the library from `docs/reference/homeCleaning.html` and fails on any difference.

**Frequencies** are *last-completion based*: the next due date is the completion date + N days or months (month ends clamped). The first due dates of a newly added set are spread like the standalone app: offset = n mod min(period, 7).

## HomeHub → template mapping

| HomeHub room type | Template |
|---|---|
| living_room | living |
| bedroom | bedroom |
| master_bedroom | bedroom |
| kids_room | bedroom |
| kitchen | kitchen |
| bathroom | bathroom |
| balcony | balcony |
| entrance | entrance |
| hallway | entrance |

Unmapped room types (dining room, office, laundry, storage, garage, garden, other) support **manual tasks only**.

| HomeHub device subtype | Template |
|---|---|
| split_ac | ac |
| window_ac | ac |
| portable_ac | ac |
| central_ac | ac |
| refrigerator | fridge |
| freezer | fridge |
| dishwasher | dishwasher |
| air_fryer | airfryer |
| vacuum_cleaner | vacuum |
| robot_vacuum | vacuum |
| microwave | microwave |
| oven | stove |
| cooker | stove |

All other device subtypes support **manual tasks only**.

## Totals

| Library | Types | Tasks | Generated now | Deferred |
|---|---|---|---|---|
| Rooms | 6 | 35 | 35 | 0 |
| Devices | 7 | 70 | 38 | 32 |

## Room templates

### 🛏️ Bedroom / غرفة النوم (`bedroom`)

| Key | English | Arabic | Frequency | Min | Priority |
|---|---|---|---|---|---|
| `bedroom_0` | Make the bed | ترتيب السرير | every day after done | 2 | normal |
| `bedroom_1` | Pick clothes up off the floor | لمّ الهدوم من الأرض | every day after done | 3 | normal |
| `bedroom_2` | Take cups & plates out of the room | شيل الأكواب والأطباق من الغرفة | every day after done | 2 | normal |
| `bedroom_3` | Change the bed sheets | تغيير ملايات السرير | every 7 days after done | 10 | normal |
| `bedroom_4` | Dust surfaces | مسح الأتربة | every 7 days after done | 8 | normal |
| `bedroom_5` | Vacuum & mop the floor | كنس وموب الأرضية | every 7 days after done | 12 | normal |
| `bedroom_6` | Clean under the bed | تنضيف تحت السرير | every month after done | 10 | low |
| `bedroom_7` | Organize the wardrobe | ترتيب الدولاب | every month after done | 20 | low |
| `bedroom_8` | Clean the AC filters | تنضيف فلاتر التكييف | every 3 months after done | 20 | normal |

### 🍳 Kitchen / المطبخ (`kitchen`)

| Key | English | Arabic | Frequency | Min | Priority |
|---|---|---|---|---|---|
| `kitchen_0` | Wash the dishes | غسيل الأطباق | every day after done | 10 | high |
| `kitchen_1` | Wipe the counter | مسح الرخامة | every day after done | 5 | normal |
| `kitchen_2` | Clean the sink | تنضيف الحوض | every day after done | 3 | normal |
| `kitchen_3` | Wipe the stovetop | مسح البوتاجاز | every day after done | 4 | normal |
| `kitchen_4` | Take out the trash | إخراج الزبالة | every day after done | 2 | high |
| `kitchen_5` | Deep-clean the stovetop | تنضيف البوتاجاز بعمق | every 7 days after done | 15 | normal |
| `kitchen_6` | Clean the microwave | تنضيف الميكروويف | every 7 days after done | 5 | normal |
| `kitchen_7` | Wipe cabinet handles | مسح مقابض الدواليب | every 7 days after done | 4 | low |
| `kitchen_8` | Mop the kitchen floor | موب أرضية المطبخ | every 7 days after done | 8 | normal |
| `kitchen_9` | Clean the fridge | تنضيف الثلاجة | every month after done | 15 | normal |
| `kitchen_10` | Clean inside the cabinets | تنضيف الدواليب من جوه | every month after done | 20 | low |

### 🚿 Bathroom / الحمام (`bathroom`)

| Key | English | Arabic | Frequency | Min | Priority |
|---|---|---|---|---|---|
| `bathroom_0` | Quick sink tidy-up | ترتيب الحوض بسرعة | every day after done | 2 | normal |
| `bathroom_1` | Hang up the towels | تعليق المناشف | every day after done | 1 | normal |
| `bathroom_2` | Clean the toilet | تنضيف التواليت | every 3 days after done | 5 | high |
| `bathroom_3` | Clean the sink | تنضيف الحوض | every 3 days after done | 4 | normal |
| `bathroom_4` | Clean the shower | تنضيف الدش | every 3 days after done | 6 | normal |
| `bathroom_5` | Deep-clean the bathroom | تنضيف الحمام بعمق | every 7 days after done | 20 | normal |

### 🛋️ Living Room / غرفة المعيشة (`living`)

| Key | English | Arabic | Frequency | Min | Priority |
|---|---|---|---|---|---|
| `living_0` | Tidy up the living room | ترتيب الصالة | every day after done | 5 | normal |
| `living_1` | Vacuum the floor | مكنسة الأرضية | every 3 days after done | 10 | normal |
| `living_2` | Dust surfaces | مسح الأتربة | every 7 days after done | 10 | normal |
| `living_3` | Mop the floor | موب الأرضية | every 7 days after done | 12 | normal |
| `living_4` | Clean the windows & glass | تنضيف الشبابيك والزجاج | every 2 months after done | 20 | low |

### 🚪 Entrance / المدخل (`entrance`)

| Key | English | Arabic | Frequency | Min | Priority |
|---|---|---|---|---|---|
| `entrance_0` | Arrange the shoes | ترتيب الجزم | every 2 days after done | 3 | normal |
| `entrance_1` | Wipe the entrance floor | مسح أرضية المدخل | every 7 days after done | 5 | normal |

### 🌿 Balcony / البلكونة (`balcony`)

| Key | English | Arabic | Frequency | Min | Priority |
|---|---|---|---|---|---|
| `balcony_0` | Water the plants | ري النباتات | every 2 days after done | 3 | normal |
| `balcony_1` | Sweep the balcony | كنس البلكونة | every 7 days after done | 8 | normal |

## Device templates

### ❄️ Air Conditioner / تكييف (`ac`, mode: seasonal)

| Key | English | Arabic | Trigger | Phase | Frequency | Min | Priority | Status |
|---|---|---|---|---|---|---|---|---|
| `f_clean` | Clean the filters | تنضيف الفلاتر | manual | start | — | 10 | high | deferred (seasonal-device) |
| `ind_clean` | Wipe the indoor unit's visible surface | تنضيف السطح الظاهر للوحدة الداخلية | manual | start | — | 8 | normal | deferred (seasonal-device) |
| `vents_clean` | Clean the air vents | تنضيف فتحات الهواء | manual | start | — | 5 | normal | deferred (seasonal-device) |
| `out_check` | Visually check the outdoor unit | فحص الوحدة الخارجية شكليًا | manual | start | — | 5 | normal | deferred (seasonal-device) |
| `drain_check` | Check the visible drain path | فحص مسار الصرف الظاهر | manual | start | — | 3 | normal | deferred (seasonal-device) |
| `test_run` | Run and test the unit | تشغيل وتجربة الوحدة | manual | start | — | 10 | high | deferred (seasonal-device) |
| `leak_check` | Check for any visible water leak | فحص أي تسريب مياه ظاهر | manual | start | — | 3 | normal | deferred (seasonal-device) |
| `noise_log` | Note any unusual sound or performance | تسجيل أي صوت أو أداء غير طبيعي | manual | start | — | 2 | low | deferred (seasonal-device) |
| `f_periodic` | Clean the filters | تنضيف الفلاتر | periodic | active | every 14 days after done | 10 | high | deferred (seasonal-device) |
| `visual_insp` | Routine visual check | فحص ظاهري دوري | periodic | active | every 14 days after done | 5 | normal | deferred (seasonal-device) |
| `vents_periodic` | Clean the air vents | تنضيف فتحات الهواء | periodic | active | every month after done | 5 | normal | deferred (seasonal-device) |
| `out_periodic` | Clean the outdoor unit where reachable | تنضيف الوحدة الخارجية حسب الإمكانية | periodic | active | every 2 months after done | 15 | low | deferred (seasonal-device) |
| `f_end` | Clean the filters | تنضيف الفلاتر | manual | end | — | 10 | normal | deferred (seasonal-device) |
| `surf_end` | Wipe the visible surface | تنضيف السطح الظاهر | manual | end | — | 8 | normal | deferred (seasonal-device) |
| `moist_end` | Check for any moisture or water | فحص أي رطوبة أو مياه | manual | end | — | 3 | normal | deferred (seasonal-device) |
| `prep_end` | Prep the unit for the off-season | تجهيز الوحدة لفترة التوقف | manual | end | — | 5 | low | deferred (seasonal-device) |

### 🍽️ Dishwasher / غسالة أطباق (`dishwasher`, mode: alwaysActive)

| Key | English | Arabic | Trigger | Phase | Frequency | Min | Priority | Status |
|---|---|---|---|---|---|---|---|---|
| `after_food` | Remove visible food residue | إزالة بقايا الطعام الظاهرة | afterCycle | — | — | 2 | normal | deferred (trigger:afterCycle) |
| `after_door` | Leave the door ajar if suitable for the unit | ترك الباب مفتوح شوية لو مناسب للجهاز | afterCycle | — | — | 1 | low | deferred (trigger:afterCycle) |
| `w_filter` | Clean the filter | تنضيف الفلتر | periodic | — | every 7 days after done | 8 | high | **generated** |
| `w_spray` | Check & clean the spray-arm holes | فحص وتنضيف فتحات ذراع الرش | periodic | — | every 7 days after done | 6 | normal | **generated** |
| `w_gasket` | Clean the door gasket & edges | تنضيف حلقة الباب والحواف | periodic | — | every 7 days after done | 5 | normal | **generated** |
| `m_cycle` | Run a suitable internal cleaning cycle | تشغيل دورة تنضيف داخلية مناسبة | periodic | — | every month after done | 15 | normal | **generated** |
| `m_edges` | Clean the interior edges | تنضيف الحواف الداخلية | periodic | — | every month after done | 8 | low | **generated** |
| `descale` | Descale when needed | إزالة الترسبات عند الحاجة | conditionBased | — | — | 15 | normal | deferred (trigger:conditionBased) |

### 🧊 Fridge / الثلاجة (`fridge`, mode: alwaysActive)

| Key | English | Arabic | Trigger | Phase | Frequency | Min | Priority | Status |
|---|---|---|---|---|---|---|---|---|
| `spoiled` | Remove any spoiled or expired food | شيل أي أكل فاسد أو منتهي | manual | — | — | 3 | high | deferred (trigger:manual) |
| `spill` | Clean up any spill right away | نضّف أي انسكاب فورًا | manual | — | — | 2 | high | deferred (trigger:manual) |
| `door_check` | Make sure the door seals properly | اتأكد إن الباب بيتقفل صح | periodic | — | every 7 days after done | 1 | normal | **generated** |
| `review` | Review the contents | راجع المحتويات | periodic | — | every 7 days after done | 5 | normal | **generated** |
| `shelves_w` | Clean dirty shelves | تنضيف الأرفف المتّسخة | periodic | — | every 7 days after done | 8 | normal | **generated** |
| `handle` | Clean the handle | تنضيف المقبض | periodic | — | every 7 days after done | 1 | low | **generated** |
| `shelves_m` | Deep-clean shelves & drawers | تنضيف الأرفف والأدراج بعمق | periodic | — | every month after done | 20 | normal | **generated** |
| `gasket_m` | Clean the door gasket | تنضيف حلقة الباب | periodic | — | every month after done | 6 | normal | **generated** |
| `ext_m` | Clean the exterior surface | تنضيف السطح الخارجي | periodic | — | every month after done | 8 | low | **generated** |
| `rear` | Clean the back/underside if safe to do so | تنضيف الخلفية/الأسفل لو آمن | periodic | — | every 4 months after done | 15 | low | **generated** |
| `gasket_insp` | Inspect the door gasket | فحص حلقة الباب | periodic | — | every 4 months after done | 3 | low | **generated** |

### 🍟 Air Fryer / قلاية هوائية (`airfryer`, mode: alwaysActive)

| Key | English | Arabic | Trigger | Phase | Frequency | Min | Priority | Status |
|---|---|---|---|---|---|---|---|---|
| `af_residue` | Remove food residue | إزالة بقايا الطعام | afterUse | — | — | 3 | high | deferred (trigger:afterUse) |
| `af_basket` | Clean the basket | تنضيف السلة | afterUse | — | — | 4 | high | deferred (trigger:afterUse) |
| `af_drawer` | Clean the drawer | تنضيف الدرج | afterUse | — | — | 3 | normal | deferred (trigger:afterUse) |
| `af_interior` | Wipe the interior when needed | مسح الداخل عند الحاجة | afterUse | — | — | 2 | low | deferred (trigger:afterUse) |
| `af_deep_basket` | Deep-clean the basket | تنضيف أعمق للسلة | periodic | — | every 7 days after done | 10 | normal | **generated** |
| `af_interior_w` | Clean the interior weekly | تنضيف الداخل أسبوعيًا | periodic | — | every 7 days after done | 8 | normal | **generated** |
| `af_ext_w` | Clean the exterior surface | تنضيف السطح الخارجي | periodic | — | every 7 days after done | 4 | low | **generated** |
| `af_element` | Clean around the heating element per manufacturer instructions | تنضيف حوالين عنصر التسخين حسب تعليمات الشركة | periodic | — | every month after done | 10 | normal | **generated** |
| `af_coating` | Check the basket & interior coating | فحص السلة والطبقة الداخلية | periodic | — | every month after done | 3 | low | **generated** |

### 🧹 Vacuum Cleaner / مكنسة كهربائية (`vacuum`, mode: alwaysActive)

| Key | English | Arabic | Trigger | Phase | Frequency | Min | Priority | Status |
|---|---|---|---|---|---|---|---|---|
| `v_empty` | Empty the bin if needed | تفريغ الحاوية لو محتاجة | afterUse | — | — | 2 | normal | deferred (trigger:afterUse) |
| `v_hair` | Remove hair & thread from the brush | شيل الشعر والخيوط من الفرشة | afterUse | — | — | 3 | normal | deferred (trigger:afterUse) |
| `v_brush_w` | Clean the main brush | تنضيف الفرشة الرئيسية | periodic | — | every 7 days after done | 6 | normal | **generated** |
| `v_attach` | Clean the attachments | تنضيف الملحقات | periodic | — | every 7 days after done | 5 | low | **generated** |
| `v_hose_w` | Check the hose/tube | فحص الخرطوم/الأنبوب | periodic | — | every 7 days after done | 3 | low | **generated** |
| `v_filter_m` | Clean the filters per type & manufacturer instructions | تنضيف الفلاتر حسب نوعها وتعليمات الشركة | periodic | — | every month after done | 10 | high | **generated** |
| `v_wheels_m` | Check the brush & wheels | فحص الفرشة والعجل | periodic | — | every month after done | 5 | low | **generated** |
| `v_hose_m` | Check the hose | فحص الخرطوم | periodic | — | every month after done | 3 | low | **generated** |
| `v_full` | Empty the bin once full | تفريغ الحاوية لما تبقى ممتلئة | conditionBased | — | — | 2 | high | deferred (trigger:conditionBased) |

### 📻 Microwave / ميكروويف (`microwave`, mode: alwaysActive)

| Key | English | Arabic | Trigger | Phase | Frequency | Min | Priority | Status |
|---|---|---|---|---|---|---|---|---|
| `mw_spill` | Wipe up any spill | مسح أي انسكاب | afterUse | — | — | 2 | normal | deferred (trigger:afterUse) |
| `mw_turntable` | Clean the turntable | تنضيف الطبق الدوار | periodic | — | every 7 days after done | 4 | normal | **generated** |
| `mw_walls` | Clean the interior walls | تنضيف الحوائط الداخلية | periodic | — | every 7 days after done | 5 | normal | **generated** |
| `mw_door` | Clean the door & handle | تنضيف الباب والمقبض | periodic | — | every 7 days after done | 3 | low | **generated** |
| `mw_ext` | Clean the exterior surface | تنضيف السطح الخارجي | periodic | — | every 7 days after done | 3 | low | **generated** |
| `mw_deep` | Deep-clean the interior | تنضيف داخلي أعمق | periodic | — | every month after done | 12 | normal | **generated** |
| `mw_vent` | Clean dust around the vents | تنضيف الأتربة حوالين فتحات التهوية | periodic | — | every month after done | 5 | low | **generated** |

### 🔥 Stovetop / البوتاجاز (`stove`, mode: alwaysActive)

| Key | English | Arabic | Trigger | Phase | Frequency | Min | Priority | Status |
|---|---|---|---|---|---|---|---|---|
| `st_residue` | Remove food residue | إزالة بقايا الطعام | afterUse | — | — | 3 | high | deferred (trigger:afterUse) |
| `st_surface` | Wipe the surface | مسح السطح | afterUse | — | — | 2 | normal | deferred (trigger:afterUse) |
| `st_spill` | Clean up any spill | تنضيف أي انسكاب | afterUse | — | — | 2 | normal | deferred (trigger:afterUse) |
| `st_grates` | Clean the grates | تنضيف الشبكات | periodic | — | every 7 days after done | 8 | normal | **generated** |
| `st_burners` | Clean the burner heads per the unit's design | تنضيف رؤوس الشعلة حسب تصميم الجهاز | periodic | — | every 7 days after done | 8 | normal | **generated** |
| `st_knobs` | Clean the knobs | تنضيف المفاتيح | periodic | — | every 7 days after done | 4 | low | **generated** |
| `st_around` | Clean around the burners | تنضيف حوالين الشعلات | periodic | — | every 7 days after done | 5 | low | **generated** |
| `st_deep` | Deep-clean the surface | تنضيف أعمق للسطح | periodic | — | every month after done | 15 | normal | **generated** |
| `st_hard` | Clean the visible hard-to-reach spots | تنضيف الأماكن صعبة الوصول الظاهرة | periodic | — | every month after done | 10 | low | **generated** |
| `st_visual` | Visual check of external parts — technical servicing by a qualified technician only | فحص ظاهري للأجزاء الخارجية — الصيانة الفنية عند فني مؤهّل فقط | periodic | — | every 2 months after done | 3 | low | **generated** |

