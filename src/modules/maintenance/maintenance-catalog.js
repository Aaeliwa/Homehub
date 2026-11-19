/**
 * Preventive maintenance SUGGESTIONS (Phase 5.5) for every Add Device category — optional, editable,
 * never created without confirmation, and NOT manufacturer-prescribed intervals.
 * `pro: true` = professional-only work (gas, refrigerant, electrical panels, batteries / inverters,
 * pressure systems, generators): HomeHub gives NO DIY steps, only a reminder to book a qualified
 * technician. User-level items are limited to safe checks / tests / consumable replacement per the
 * device manual. Routine cleaning lives in the Cleaning module, not here.
 */
const M = (key, titleAr, titleEn, unit, interval, pro = false) => Object.freeze({ key, titleAr, titleEn, recurrence: { kind: 'every', unit, interval }, pro });

export const CATEGORY_MAINTENANCE = Object.freeze({
  air_conditioning: [M('ac_pro_service', 'صيانة دورية للمكيف بواسطة فني معتمد', 'AC service by a qualified technician', 'month', 12, true),
    M('ac_outdoor_check', 'فحص بصري للوحدة الخارجية (عوائق، تسريب)', 'Visual check of the outdoor unit (blockage, leaks)', 'month', 6)],
  refrigeration: [M('fr_seal_check', 'فحص جوان الباب وإحكام الغلق', 'Check the door seal closes properly', 'month', 6),
    M('fr_pro_check', 'فحص منظومة التبريد بواسطة فني (عند ضعف التبريد أو سنويًا)', 'Cooling system check by a technician (yearly or if cooling weakens)', 'month', 12, true)],
  laundry: [M('ld_hoses', 'فحص خراطيم المياه بحثًا عن تشققات أو تسريب', 'Inspect water hoses for cracks or leaks', 'month', 6),
    M('ld_level', 'فحص اتزان الجهاز وثباته', 'Check the appliance is level and stable', 'month', 12)],
  kitchen_appliance: [M('ka_cords', 'فحص سلك الكهرباء والقابس بحثًا عن تلف', 'Inspect the power cord and plug for damage', 'month', 6)],
  water_system: [M('ws_leaks', 'فحص الوصلات بحثًا عن تسريب', 'Check fittings for leaks', 'month', 3)],
  audio_video: [M('av_vent', 'فحص التهوية والكابلات', 'Check ventilation and cables', 'month', 12),
    M('av_updates', 'تحديث برامج الجهاز', 'Install software updates', 'month', 6)],
  computing: [M('cp_backup', 'نسخ احتياطي وتحديثات البرامج', 'Back up and install updates', 'month', 1),
    M('cp_battery', 'مراجعة حالة البطارية من إعدادات الجهاز', "Review battery health in the device's settings", 'month', 6)],
  networking: [M('nw_firmware', 'تحديث برنامج الجهاز (Firmware)', 'Update the firmware', 'month', 3),
    M('nw_passwords', 'مراجعة كلمات المرور وإعدادات الأمان', 'Review passwords and security settings', 'month', 12)],
  cleaning_equipment: [M('ce_parts', 'استبدال الفلاتر أو الفرش حسب دليل الجهاز', 'Replace filters or brushes per the manual', 'month', 6)],
  lighting: [M('lt_check', 'فحص الإضاءة واستبدال اللمبات التالفة', 'Check fittings and replace failed bulbs', 'month', 12)],
  electrical: [M('el_pro_inspect', 'فحص التمديدات الكهربائية بواسطة كهربائي معتمد', 'Electrical inspection by a licensed electrician', 'month', 24, true)],
  power: [M('pw_pro_service', 'صيانة دورية بواسطة فني مختص', 'Service by a qualified technician', 'month', 12, true),
    M('pw_status', 'مراجعة مؤشرات الحالة والإنذارات (بدون فتح الجهاز)', 'Review status lights and alarms (do not open the unit)', 'month', 1)],
  heating: [M('ht_cord', 'فحص السلك والقابس ومفتاح الأمان', 'Check the cord, plug and safety switch', 'month', 12)],
  ventilation: [M('vt_noise', 'فحص الاهتزاز أو الأصوات غير الطبيعية', 'Check for unusual vibration or noise', 'month', 6)],
  plumbing: [M('pl_leaks', 'فحص التسريب أسفل الأحواض وحول الوصلات', 'Check for leaks under sinks and around fittings', 'month', 3)],
  security: [M('sc_test', 'اختبار عمل الجهاز', 'Test that the device works', 'month', 1),
    M('sc_firmware', 'تحديث برنامج الجهاز', 'Update the firmware', 'month', 6)],
  furniture: [M('fn_fittings', 'فحص الثبات وإحكام المسامير والمفصلات', 'Check stability and tighten fittings', 'month', 12)],
  outdoor: [M('od_season', 'فحص الجهاز قبل موسم الاستخدام', 'Inspect before the season of use', 'month', 12)],
  other: [M('ot_inspect', 'فحص عام لحالة الجهاز', 'General condition check', 'month', 12)],
});

/** Subtype-specific additions (only where the generic item would be poor or unsafe advice). */
export const SUBTYPE_MAINTENANCE = Object.freeze({
  water_heater: [M('wh_pro', 'فحص السخان وصمام الأمان بواسطة فني مختص', 'Heater and safety valve check by a qualified technician', 'month', 12, true)],
  water_filter: [M('wf_cartridge', 'استبدال خرطوشة الفلتر حسب دليل الجهاز', 'Replace the filter cartridge per the manual', 'month', 6)],
  cooker: [M('ck_gas', 'فحص وصلات الغاز بواسطة فني معتمد', 'Gas connection check by a certified technician', 'month', 12, true)],
  oven: [M('ov_gas', 'فحص الفرن ووصلات الغاز بواسطة فني معتمد', 'Oven and gas connection check by a certified technician', 'month', 12, true)],
  grill: [M('gr_gas', 'فحص خرطوم ومنظم الغاز بواسطة فني', 'Gas hose and regulator check by a technician', 'month', 12, true)],
  electrical_panel: [M('ep_rcd', 'الضغط على زر الاختبار في قاطع التسريب الأرضي', 'Press the test button on the earth-leakage breaker (RCD)', 'month', 3)],
  ups: [M('ups_battery', 'فحص بطارية UPS بواسطة فني (لا تفتح الجهاز)', 'UPS battery check by a technician (do not open the unit)', 'month', 12, true)],
  generator: [M('gen_pro', 'صيانة المولد بواسطة فني مختص', 'Generator service by a qualified technician', 'month', 6, true)],
  solar_panel: [M('sp_pro', 'فحص الألواح والتوصيلات بواسطة فني مختص', 'Panel and wiring inspection by a qualified technician', 'month', 12, true)],
  battery_bank: [M('bb_pro', 'فحص البطاريات بواسطة فني مختص', 'Battery inspection by a qualified technician', 'month', 6, true)],
  inverter: [M('inv_pro', 'فحص الإنفرتر بواسطة فني مختص', 'Inverter inspection by a qualified technician', 'month', 12, true)],
  alarm: [M('al_test', 'اختبار الإنذار وتغيير البطارية عند الحاجة', 'Test the alarm; replace its battery when needed', 'month', 1)],
  smart_lock: [M('sl_battery', 'فحص بطارية القفل الذكي', 'Check the smart lock battery', 'month', 3)],
  water_pump: [M('wp_pro', 'فحص المضخة بواسطة فني مختص', 'Pump check by a qualified technician', 'month', 12, true)],
  central_ac: [M('cac_pro', 'صيانة التكييف المركزي بواسطة شركة معتمدة', 'Central AC service by an approved company', 'month', 6, true)],
});

export function maintenanceSuggestionsFor(device) {
  const cat = CATEGORY_MAINTENANCE[device && device.category] || CATEGORY_MAINTENANCE.other;
  const sub = (device && device.subtype && SUBTYPE_MAINTENANCE[device.subtype]) || [];
  const seen = new Set(); const out = [];
  for (const s of [...sub, ...cat]) if (!seen.has(s.key)) { seen.add(s.key); out.push(s); }
  return out;
}
