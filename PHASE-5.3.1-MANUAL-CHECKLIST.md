# Phase 5.3.1 — Short manual production test checklist

Run **only after** you approve deployment, the real emulator passes the normal and strict runs (106/106 each), and you have deployed the rules, then the hosting. Optional but recommended first: export a Firestore backup from the console.

1. **Home page:** the Cleaning card looks exactly like the Rooms and Devices cards (same card, icon, title, number and spacing), on desktop and on a phone. Tapping it opens Cleaning.
2. **Recognition:** open Cleaning as an adult with cleaning rights. A banner says how many tasks are suggested for your existing rooms/devices (kitchen, bathroom, bedrooms, living room, entrance or hallway, balcony; dishwasher, fridge, air fryer, vacuum, microwave, stove or oven). AC shows no tasks: seasonal tasks are deferred.
3. **Review:** each room/device lists its tasks with frequency ("Every 7 day(s) after it's done") and minutes. Untick one task, then **Add selected tasks**.
4. **Idempotent:** the banner disappears. Refresh, and on a second phone or as a second adult open Cleaning: **no banner**, and no duplicate tasks under Manage tasks. The unticked task appears there as "not added (declined)".
5. **Existing data intact:** your manual tasks, their history, and finance, savings and Zakat screens are unchanged.
6. **Schedule:** mark a daily template task **Done**. It counts in today's progress and appears under Upcoming for tomorrow. **Reopen** it with a reason: it is due today again.
7. **Lifecycle:**
   - rename a room in Rooms → the new name shows on its tasks;
   - move a device to another room → its tasks show the new room;
   - archive a room → its template tasks disappear from Cleaning;
   - restore it → they are back.
8. **New device:** add a microwave in Devices. Cleaning offers only its 6 tasks.
9. **Permissions:** a viewer or child sees no setup banner and cannot add template tasks.
10. **Arabic:** switch to Arabic. Titles, frequencies and the banner read correctly right-to-left.

If anything fails, stop and send a screenshot plus the steps. Do not edit data by hand.
