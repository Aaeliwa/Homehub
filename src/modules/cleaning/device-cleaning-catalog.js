/**
 * Device cleaning catalog (Phase 5.4d) — SUGGESTED cleaning tasks for EVERY Add Device category (and
 * therefore every subtype, incl. 'other' and a null subtype). Suggestions are editable defaults, never
 * created automatically and NOT manufacturer guidance. Servicing / repairs are maintenance — excluded.
 * `after` = N days/months after the task was last done (HomeHub completion-based recurrence).
 */
const S = (key, titleAr, titleEn, unit, n, minutes, caveat = null) => Object.freeze({ key, titleAr, titleEn, recurrence: { kind: 'after', unit, interval: n }, minutes, caveat });

/** Safety caveat ids → i18n keys cleaning.catalog.caveat.<id>. */
export const CAVEATS = Object.freeze(['unplug', 'noWater', 'gas', 'panel', 'heights', 'battery', 'chemicals']);

export const CATEGORY_SUGGESTIONS = Object.freeze({
  air_conditioning: [S('ac_dust_vents', 'مسح فتحات وغطاء المكيف من الخارج', 'Wipe the AC vents and cover (outside)', 'day', 14, 5, 'unplug'),
    S('ac_filter', 'غسل فلتر المكيف', 'Wash the AC filter', 'month', 1, 15, 'unplug')],
  refrigeration: [S('fr_wipe_shelves', 'مسح أرفف الثلاجة', 'Wipe the fridge shelves', 'day', 7, 10),
    S('fr_expired', 'إزالة الأطعمة المنتهية', 'Remove expired food', 'day', 7, 5),
    S('fr_gasket', 'تنظيف جوان الباب', 'Clean the door seal', 'month', 1, 5)],
  laundry: [S('ld_wipe', 'مسح الجهاز من الخارج', 'Wipe the appliance outside', 'day', 14, 5, 'unplug'),
    S('ld_lint', 'تنظيف فلتر الوبر أو درج المنظف', 'Clean the lint filter or detergent drawer', 'day', 14, 10, 'unplug')],
  kitchen_appliance: [S('ka_wipe', 'مسح الجهاز من الخارج', 'Wipe the appliance outside', 'day', 7, 5, 'unplug'),
    S('ka_inside', 'تنظيف الجهاز من الداخل', 'Clean the inside', 'month', 1, 15, 'unplug')],
  water_system: [S('ws_wipe', 'مسح الجهاز والوصلات من الخارج', 'Wipe the unit and fittings (outside)', 'month', 1, 10, 'unplug')],
  audio_video: [S('av_dust', 'إزالة الغبار عن الجهاز', 'Dust the device', 'day', 7, 5, 'noWater'),
    S('av_screen', 'مسح الشاشة بقطعة جافة ناعمة', 'Wipe the screen with a dry soft cloth', 'day', 14, 5, 'noWater')],
  computing: [S('cp_dust', 'إزالة الغبار عن الجهاز والكابلات', 'Dust the device and cables', 'day', 14, 5, 'noWater'),
    S('cp_keys', 'تنظيف لوحة المفاتيح والشاشة', 'Clean the keyboard and screen', 'month', 1, 10, 'unplug')],
  networking: [S('nw_dust', 'إزالة الغبار عن الجهاز وفتحات التهوية', 'Dust the device and its vents', 'month', 1, 5, 'noWater')],
  cleaning_equipment: [S('ce_empty', 'تفريغ الخزان أو الكيس', 'Empty the bin or bag', 'day', 7, 5),
    S('ce_brush', 'تنظيف الفرشاة والفلتر', 'Clean the brush and filter', 'month', 1, 10, 'unplug')],
  lighting: [S('lt_dust', 'إزالة الغبار عن الإضاءة', 'Dust the light fitting', 'month', 1, 5, 'heights')],
  electrical: [S('el_dust', 'إزالة الغبار من الخارج فقط', 'Dust the outside only', 'month', 2, 5, 'panel')],
  power: [S('pw_wipe', 'مسح الجهاز من الخارج', 'Wipe the unit outside', 'month', 1, 10, 'battery')],
  heating: [S('ht_dust', 'إزالة الغبار عن السخان', 'Dust the heater', 'day', 14, 5, 'unplug')],
  ventilation: [S('vt_blades', 'تنظيف الريش والشبكة', 'Clean the blades and grille', 'month', 1, 15, 'unplug')],
  plumbing: [S('pl_wipe', 'تنظيف وتلميع', 'Clean and polish', 'day', 7, 10, 'chemicals'),
    S('pl_limescale', 'إزالة الترسبات الكلسية', 'Remove limescale', 'month', 1, 15, 'chemicals')],
  security: [S('sc_lens', 'مسح العدسة أو الواجهة بقطعة جافة', 'Wipe the lens or panel with a dry cloth', 'month', 1, 5, 'noWater')],
  furniture: [S('fn_dust', 'إزالة الغبار والمسح', 'Dust and wipe', 'day', 7, 10),
    S('fn_vacuum', 'شفط الغبار أو تنظيف القماش', 'Vacuum or clean the fabric', 'month', 1, 20)],
  outdoor: [S('od_clean', 'تنظيف الجهاز بعد الاستخدام', 'Clean the equipment after use', 'day', 14, 15, 'unplug')],
  other: [S('ot_wipe', 'مسح الجهاز من الخارج', 'Wipe the device outside', 'day', 14, 5, 'unplug')],
});

/** A few subtype-specific additions where a generic suggestion would be poor advice. */
export const SUBTYPE_SUGGESTIONS = Object.freeze({
  washing_machine: [S('wm_drum', 'تنظيف حوض الغسالة (دورة تنظيف)', 'Clean the drum (cleaning cycle)', 'month', 1, 10)],
  washer_dryer: [S('wm_drum', 'تنظيف حوض الغسالة (دورة تنظيف)', 'Clean the drum (cleaning cycle)', 'month', 1, 10)],
  kettle: [S('kt_descale', 'إزالة الترسبات من الغلاية', 'Descale the kettle', 'month', 1, 10, 'unplug')],
  coffee_machine: [S('cm_descale', 'إزالة الترسبات من ماكينة القهوة', 'Descale the coffee machine', 'month', 1, 15, 'unplug')],
  robot_vacuum: [S('rv_sensors', 'مسح حساسات المكنسة الآلية', 'Wipe the robot vacuum sensors', 'day', 14, 5)],
  solar_panel: [S('sp_rinse', 'تنظيف الألواح الشمسية من الأتربة', 'Clean dust off the solar panels', 'month', 1, 30, 'heights')],
  grill: [S('gr_grate', 'تنظيف شبكة الشواية', 'Clean the grill grate', 'day', 14, 15, 'gas')],
  cooker: [S('ck_burners', 'تنظيف رؤوس الشعلات', 'Clean the burner caps', 'day', 14, 15, 'gas')],
  oven: [S('ov_inside', 'تنظيف الفرن من الداخل', 'Clean inside the oven', 'month', 1, 30, 'gas')],
  toilet: [S('tl_clean', 'تنظيف المرحاض', 'Clean the toilet', 'day', 3, 10, 'chemicals')],
  air_purifier: [S('ap_prefilter', 'تنظيف الفلتر الأولي', 'Clean the pre-filter', 'day', 14, 10, 'unplug')],
});

/** Suggestions for a device: its category's + its subtype's (null / 'other' subtype → category only). */
export function suggestionsFor(device) {
  const cat = CATEGORY_SUGGESTIONS[device && device.category] || CATEGORY_SUGGESTIONS.other;
  const sub = (device && device.subtype && SUBTYPE_SUGGESTIONS[device.subtype]) || [];
  const seen = new Set(); const out = [];
  for (const s of [...sub, ...cat]) if (!seen.has(s.key)) { seen.add(s.key); out.push(s); }
  return out;
}
