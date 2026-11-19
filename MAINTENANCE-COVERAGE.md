# Maintenance Coverage Matrix (Phase 5.5)

Generated from the **live** Add Device taxonomy (`DEVICE_CATEGORIES`) and `maintenance-catalog.js`.

- **Every row is manually linkable:** any active device of the Home can have preventive plans and fault reports (unit test over all 104 combinations; rules check "active device of this Home").
- **Suggestions are optional, editable, never created without confirmation, and not manufacturer intervals.**
- 🛠 = **professional only.** HomeHub gives no DIY steps for gas, refrigerant, electrical panels, batteries / inverters, pressure systems or generators.
- Routine **cleaning** stays in the Cleaning module (see DEVICE-CLEANING-COVERAGE.md).

| Category | Subtype | Manually linkable | Suggested maintenance (default interval, editable) | Professional-only items |
|---|---|---|---|---|
| air_conditioning | split_ac | yes | 🛠 AC service by a qualified technician — every 12 months after done<br>Visual check of the outdoor unit (blockage, leaks) — every 6 months after done | AC service by a qualified technician |
| air_conditioning | window_ac | yes | 🛠 AC service by a qualified technician — every 12 months after done<br>Visual check of the outdoor unit (blockage, leaks) — every 6 months after done | AC service by a qualified technician |
| air_conditioning | portable_ac | yes | 🛠 AC service by a qualified technician — every 12 months after done<br>Visual check of the outdoor unit (blockage, leaks) — every 6 months after done | AC service by a qualified technician |
| air_conditioning | central_ac | yes | 🛠 Central AC service by an approved company — every 6 months after done<br>🛠 AC service by a qualified technician — every 12 months after done<br>Visual check of the outdoor unit (blockage, leaks) — every 6 months after done | Central AC service by an approved company; AC service by a qualified technician |
| air_conditioning | other | yes | 🛠 AC service by a qualified technician — every 12 months after done<br>Visual check of the outdoor unit (blockage, leaks) — every 6 months after done | AC service by a qualified technician |
| air_conditioning | (none) | yes | 🛠 AC service by a qualified technician — every 12 months after done<br>Visual check of the outdoor unit (blockage, leaks) — every 6 months after done | AC service by a qualified technician |
| refrigeration | refrigerator | yes | Check the door seal closes properly — every 6 months after done<br>🛠 Cooling system check by a technician (yearly or if cooling weakens) — every 12 months after done | Cooling system check by a technician (yearly or if cooling weakens) |
| refrigeration | freezer | yes | Check the door seal closes properly — every 6 months after done<br>🛠 Cooling system check by a technician (yearly or if cooling weakens) — every 12 months after done | Cooling system check by a technician (yearly or if cooling weakens) |
| refrigeration | water_dispenser | yes | Check the door seal closes properly — every 6 months after done<br>🛠 Cooling system check by a technician (yearly or if cooling weakens) — every 12 months after done | Cooling system check by a technician (yearly or if cooling weakens) |
| refrigeration | other | yes | Check the door seal closes properly — every 6 months after done<br>🛠 Cooling system check by a technician (yearly or if cooling weakens) — every 12 months after done | Cooling system check by a technician (yearly or if cooling weakens) |
| refrigeration | (none) | yes | Check the door seal closes properly — every 6 months after done<br>🛠 Cooling system check by a technician (yearly or if cooling weakens) — every 12 months after done | Cooling system check by a technician (yearly or if cooling weakens) |
| laundry | washing_machine | yes | Inspect water hoses for cracks or leaks — every 6 months after done<br>Check the appliance is level and stable — every 12 months after done | — |
| laundry | dryer | yes | Inspect water hoses for cracks or leaks — every 6 months after done<br>Check the appliance is level and stable — every 12 months after done | — |
| laundry | washer_dryer | yes | Inspect water hoses for cracks or leaks — every 6 months after done<br>Check the appliance is level and stable — every 12 months after done | — |
| laundry | iron | yes | Inspect water hoses for cracks or leaks — every 6 months after done<br>Check the appliance is level and stable — every 12 months after done | — |
| laundry | other | yes | Inspect water hoses for cracks or leaks — every 6 months after done<br>Check the appliance is level and stable — every 12 months after done | — |
| laundry | (none) | yes | Inspect water hoses for cracks or leaks — every 6 months after done<br>Check the appliance is level and stable — every 12 months after done | — |
| kitchen_appliance | oven | yes | 🛠 Oven and gas connection check by a certified technician — every 12 months after done<br>Inspect the power cord and plug for damage — every 6 months after done | Oven and gas connection check by a certified technician |
| kitchen_appliance | cooker | yes | 🛠 Gas connection check by a certified technician — every 12 months after done<br>Inspect the power cord and plug for damage — every 6 months after done | Gas connection check by a certified technician |
| kitchen_appliance | microwave | yes | Inspect the power cord and plug for damage — every 6 months after done | — |
| kitchen_appliance | dishwasher | yes | Inspect the power cord and plug for damage — every 6 months after done | — |
| kitchen_appliance | coffee_machine | yes | Inspect the power cord and plug for damage — every 6 months after done | — |
| kitchen_appliance | blender | yes | Inspect the power cord and plug for damage — every 6 months after done | — |
| kitchen_appliance | kettle | yes | Inspect the power cord and plug for damage — every 6 months after done | — |
| kitchen_appliance | air_fryer | yes | Inspect the power cord and plug for damage — every 6 months after done | — |
| kitchen_appliance | other | yes | Inspect the power cord and plug for damage — every 6 months after done | — |
| kitchen_appliance | (none) | yes | Inspect the power cord and plug for damage — every 6 months after done | — |
| water_system | water_heater | yes | 🛠 Heater and safety valve check by a qualified technician — every 12 months after done<br>Check fittings for leaks — every 3 months after done | Heater and safety valve check by a qualified technician |
| water_system | water_filter | yes | Replace the filter cartridge per the manual — every 6 months after done<br>Check fittings for leaks — every 3 months after done | — |
| water_system | water_pump | yes | 🛠 Pump check by a qualified technician — every 12 months after done<br>Check fittings for leaks — every 3 months after done | Pump check by a qualified technician |
| water_system | water_tank | yes | Check fittings for leaks — every 3 months after done | — |
| water_system | other | yes | Check fittings for leaks — every 3 months after done | — |
| water_system | (none) | yes | Check fittings for leaks — every 3 months after done | — |
| audio_video | television | yes | Check ventilation and cables — every 12 months after done<br>Install software updates — every 6 months after done | — |
| audio_video | receiver | yes | Check ventilation and cables — every 12 months after done<br>Install software updates — every 6 months after done | — |
| audio_video | speaker | yes | Check ventilation and cables — every 12 months after done<br>Install software updates — every 6 months after done | — |
| audio_video | projector | yes | Check ventilation and cables — every 12 months after done<br>Install software updates — every 6 months after done | — |
| audio_video | other | yes | Check ventilation and cables — every 12 months after done<br>Install software updates — every 6 months after done | — |
| audio_video | (none) | yes | Check ventilation and cables — every 12 months after done<br>Install software updates — every 6 months after done | — |
| computing | desktop_computer | yes | Back up and install updates — every 1 month after done<br>Review battery health in the device's settings — every 6 months after done | — |
| computing | laptop | yes | Back up and install updates — every 1 month after done<br>Review battery health in the device's settings — every 6 months after done | — |
| computing | tablet | yes | Back up and install updates — every 1 month after done<br>Review battery health in the device's settings — every 6 months after done | — |
| computing | printer | yes | Back up and install updates — every 1 month after done<br>Review battery health in the device's settings — every 6 months after done | — |
| computing | other | yes | Back up and install updates — every 1 month after done<br>Review battery health in the device's settings — every 6 months after done | — |
| computing | (none) | yes | Back up and install updates — every 1 month after done<br>Review battery health in the device's settings — every 6 months after done | — |
| networking | router | yes | Update the firmware — every 3 months after done<br>Review passwords and security settings — every 12 months after done | — |
| networking | modem | yes | Update the firmware — every 3 months after done<br>Review passwords and security settings — every 12 months after done | — |
| networking | access_point | yes | Update the firmware — every 3 months after done<br>Review passwords and security settings — every 12 months after done | — |
| networking | network_switch | yes | Update the firmware — every 3 months after done<br>Review passwords and security settings — every 12 months after done | — |
| networking | other | yes | Update the firmware — every 3 months after done<br>Review passwords and security settings — every 12 months after done | — |
| networking | (none) | yes | Update the firmware — every 3 months after done<br>Review passwords and security settings — every 12 months after done | — |
| cleaning_equipment | vacuum_cleaner | yes | Replace filters or brushes per the manual — every 6 months after done | — |
| cleaning_equipment | robot_vacuum | yes | Replace filters or brushes per the manual — every 6 months after done | — |
| cleaning_equipment | steam_cleaner | yes | Replace filters or brushes per the manual — every 6 months after done | — |
| cleaning_equipment | other | yes | Replace filters or brushes per the manual — every 6 months after done | — |
| cleaning_equipment | (none) | yes | Replace filters or brushes per the manual — every 6 months after done | — |
| lighting | ceiling_light | yes | Check fittings and replace failed bulbs — every 12 months after done | — |
| lighting | lamp | yes | Check fittings and replace failed bulbs — every 12 months after done | — |
| lighting | outdoor_light | yes | Check fittings and replace failed bulbs — every 12 months after done | — |
| lighting | other | yes | Check fittings and replace failed bulbs — every 12 months after done | — |
| lighting | (none) | yes | Check fittings and replace failed bulbs — every 12 months after done | — |
| electrical | electrical_panel | yes | Press the test button on the earth-leakage breaker (RCD) — every 3 months after done<br>🛠 Electrical inspection by a licensed electrician — every 24 months after done | Electrical inspection by a licensed electrician |
| electrical | ups | yes | 🛠 UPS battery check by a technician (do not open the unit) — every 12 months after done<br>🛠 Electrical inspection by a licensed electrician — every 24 months after done | UPS battery check by a technician (do not open the unit); Electrical inspection by a licensed electrician |
| electrical | voltage_stabilizer | yes | 🛠 Electrical inspection by a licensed electrician — every 24 months after done | Electrical inspection by a licensed electrician |
| electrical | other | yes | 🛠 Electrical inspection by a licensed electrician — every 24 months after done | Electrical inspection by a licensed electrician |
| electrical | (none) | yes | 🛠 Electrical inspection by a licensed electrician — every 24 months after done | Electrical inspection by a licensed electrician |
| power | generator | yes | 🛠 Generator service by a qualified technician — every 6 months after done<br>🛠 Service by a qualified technician — every 12 months after done<br>Review status lights and alarms (do not open the unit) — every 1 month after done | Generator service by a qualified technician; Service by a qualified technician |
| power | solar_panel | yes | 🛠 Panel and wiring inspection by a qualified technician — every 12 months after done<br>🛠 Service by a qualified technician — every 12 months after done<br>Review status lights and alarms (do not open the unit) — every 1 month after done | Panel and wiring inspection by a qualified technician; Service by a qualified technician |
| power | inverter | yes | 🛠 Inverter inspection by a qualified technician — every 12 months after done<br>🛠 Service by a qualified technician — every 12 months after done<br>Review status lights and alarms (do not open the unit) — every 1 month after done | Inverter inspection by a qualified technician; Service by a qualified technician |
| power | battery_bank | yes | 🛠 Battery inspection by a qualified technician — every 6 months after done<br>🛠 Service by a qualified technician — every 12 months after done<br>Review status lights and alarms (do not open the unit) — every 1 month after done | Battery inspection by a qualified technician; Service by a qualified technician |
| power | other | yes | 🛠 Service by a qualified technician — every 12 months after done<br>Review status lights and alarms (do not open the unit) — every 1 month after done | Service by a qualified technician |
| power | (none) | yes | 🛠 Service by a qualified technician — every 12 months after done<br>Review status lights and alarms (do not open the unit) — every 1 month after done | Service by a qualified technician |
| heating | space_heater | yes | Check the cord, plug and safety switch — every 12 months after done | — |
| heating | other | yes | Check the cord, plug and safety switch — every 12 months after done | — |
| heating | (none) | yes | Check the cord, plug and safety switch — every 12 months after done | — |
| ventilation | ceiling_fan | yes | Check for unusual vibration or noise — every 6 months after done | — |
| ventilation | stand_fan | yes | Check for unusual vibration or noise — every 6 months after done | — |
| ventilation | exhaust_fan | yes | Check for unusual vibration or noise — every 6 months after done | — |
| ventilation | air_purifier | yes | Check for unusual vibration or noise — every 6 months after done | — |
| ventilation | other | yes | Check for unusual vibration or noise — every 6 months after done | — |
| ventilation | (none) | yes | Check for unusual vibration or noise — every 6 months after done | — |
| plumbing | faucet | yes | Check for leaks under sinks and around fittings — every 3 months after done | — |
| plumbing | toilet | yes | Check for leaks under sinks and around fittings — every 3 months after done | — |
| plumbing | shower_unit | yes | Check for leaks under sinks and around fittings — every 3 months after done | — |
| plumbing | other | yes | Check for leaks under sinks and around fittings — every 3 months after done | — |
| plumbing | (none) | yes | Check for leaks under sinks and around fittings — every 3 months after done | — |
| security | camera | yes | Test that the device works — every 1 month after done<br>Update the firmware — every 6 months after done | — |
| security | alarm | yes | Test the alarm; replace its battery when needed — every 1 month after done<br>Test that the device works — every 1 month after done<br>Update the firmware — every 6 months after done | — |
| security | smart_lock | yes | Check the smart lock battery — every 3 months after done<br>Test that the device works — every 1 month after done<br>Update the firmware — every 6 months after done | — |
| security | intercom | yes | Test that the device works — every 1 month after done<br>Update the firmware — every 6 months after done | — |
| security | other | yes | Test that the device works — every 1 month after done<br>Update the firmware — every 6 months after done | — |
| security | (none) | yes | Test that the device works — every 1 month after done<br>Update the firmware — every 6 months after done | — |
| furniture | sofa | yes | Check stability and tighten fittings — every 12 months after done | — |
| furniture | bed | yes | Check stability and tighten fittings — every 12 months after done | — |
| furniture | wardrobe | yes | Check stability and tighten fittings — every 12 months after done | — |
| furniture | table | yes | Check stability and tighten fittings — every 12 months after done | — |
| furniture | other | yes | Check stability and tighten fittings — every 12 months after done | — |
| furniture | (none) | yes | Check stability and tighten fittings — every 12 months after done | — |
| outdoor | garden_equipment | yes | Inspect before the season of use — every 12 months after done | — |
| outdoor | pool_equipment | yes | Inspect before the season of use — every 12 months after done | — |
| outdoor | grill | yes | 🛠 Gas hose and regulator check by a technician — every 12 months after done<br>Inspect before the season of use — every 12 months after done | Gas hose and regulator check by a technician |
| outdoor | other | yes | Inspect before the season of use — every 12 months after done | — |
| outdoor | (none) | yes | Inspect before the season of use — every 12 months after done | — |
| other | (none) | yes | General condition check — every 12 months after done | — |

**Rows:** 104 (85 subtypes + a null subtype per category). **Rows with a professional-only item:** 27.

**Safety policy:**
- User-level items are limited to checks, tests and consumable replacement per the device manual.
- Hazardous work is a reminder to book a qualified technician.
- A unit test enforces that no user-level item mentions gas or refrigerant work.
