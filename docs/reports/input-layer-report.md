# Input Layer and Gamepad (Proposal 0014)

_Branch `feature/input-layer`, 2026-11-23. Decisions 360–367; plan `docs/plans/input-layer.md`. This report is the pull request's description._

## Summary

Every input now goes through an input layer in `src/ui/input/` that turns the keyboard, the mouse, gamepads and joysticks into named actions and tuned axes. A DualShock 4 (or any pad Chrome reports with the standard mapping) flies the jet and both helicopters with the Mode 2 layout of Proposal 0014, drives every menu, and is rebindable on a new bindings screen. Keyboard and mouse behave exactly as before: their tests pass unchanged.

What you get:

- **Flight.** Right stick pitch and roll (cyclic in the helicopters); left stick rudder or pedals and the throttle as a rate (collective as a climb rate). The throttle stops at military, passes into afterburner after a 0.5 s push, and snaps to military or idle on a double tap. Pushing it up releases the parking brake; holding it back at idle brakes the wheels. The HUD shows the stored lever as a bar beside THR while a pad is connected.
- **Buttons.** R2 fires, ✕ gear (hover hold), ○ speedbrake, □ next weapon, △ radar lock and target cycle, R3 padlock, hold L1 for free look with the right stick (it springs back on release), D-pad for master modes and display pages, L1 chords for the rest, Options pauses, Share is help (mission search on the map). Secondary release, countermeasures and the cargo hook are bound but reserved until R3 and R4.
- **Cross-talk guard.** Each left-stick axis ignores the other's wobble: a firm push up never yaws, a firm yaw never moves the throttle.
- **Menus by pad.** Start screen, pause menu, help and summary cards, mission search, the bindings screen, and the displays (display focus, L1 + Share): the D-pad moves an amber focus ring, ✕ presses, ○ goes back.
- **Bindings screen** (pause menu or start screen → **Controls and gamepad…**): press-to-bind for keys, mouse side buttons, pad buttons, stick pushes and chords; per-axis deadzone, curve, inversion, sensitivity and rate or lever with live meters; yaw on the bumpers; rumble test; export and import as JSON. Saved in the browser per device and aircraft class.
- **Connect prompt and toasts.** Browsers hide a pad until a button is pressed; the start screen and pause menu ask for one, and a toast reports each connect and disconnect.
- **Rumble** for the gun, the stall buffet, touchdown and kills, where the browser and pad support it.

## Testing It Tonight (Chrome on a Laptop, Windows 11)

The live build deploys from `main` only, so run the branch locally.

1. Get the branch and start the dev server in PowerShell:

   ```powershell
   git fetch origin
   ```

   ```powershell
   git checkout feature/input-layer
   ```

   ```powershell
   npm install
   ```

   ```powershell
   npm run dev
   ```

2. **Connect the DualShock 4.** By USB: plug it in. By Bluetooth: hold Share and the PS button until the light bar flashes, then pair it in Windows Settings → Bluetooth & devices → Add device → Bluetooth ("Wireless Controller"). Close DS4Windows and Steam's controller support if they run: DS4Windows adds a second, virtual Xbox pad (the layer merges both, but inputs then arrive twice), and Steam Input can take the pad from other apps.
3. **Open** `http://localhost:5173/?mode=freeflight&seed=1` in Chrome. The start screen's bottom line says "Gamepad: none seen yet". **Press ✕.** A toast names the pad; the line reads "Wireless Controller (PlayStation layout…)".
4. **Pick a base by pad:** D-pad ↓ until an airbase row has the amber ring, ✕ selects it, ✕ again flies (or use the mouse as before).
5. **Take off:** push the left stick up ("Parking brake released", the THR bar rises); keep it up at military for half a second ("Afterburner"); let go and the lever stays. At about 150 kt pull the right stick back to about 9° and let go; ✕ raises the gear.
6. **Check the guard:** push the left stick fully up while drifting sideways: the rudder stays still. Push it fully sideways while drifting up: the throttle stays still.
7. **Look and padlock:** hold L1 and move the right stick; release and the view springs back. With traffic on (pause menu → Options), △ locks a contact and R3 padlocks it.
8. **Throttle snaps:** double-tap the left stick down ("Throttle: idle"), double-tap up ("Throttle: military").
9. **Displays:** D-pad ↑ steps the master mode, ← and → page the displays; L1 + Share turns on display focus (HUD message): the D-pad walks the bezel buttons, ✕ presses, ○ leaves.
10. **Pause and bindings:** Options pauses; walk the pause menu with the D-pad to **Controls and gamepad…** and press ✕. Move both sticks and watch the meters under each axis; rebind a button with **Bind** (press the new button, or hold one and press another for a chord); try **Test rumble**; ○ closes the screen and leaves the pause menu; Options resumes.
11. **Land:** gear down (✕), throttle back, fly the approach; after touchdown hold the left stick down at idle to brake. Touchdown rumbles if rumble works.
12. **Helicopter:** on the start screen choose the MH-14 Wren (the aircraft select steps with ← and → when focused). Left stick up climbs and centered holds the altitude; right stick fore and aft tilts the nose and springs back; ✕ hover hold.
13. **Unplug** the cable or switch the pad off (hold PS 10 s): a toast says so, and nothing stays held.
14. **Keyboard and mouse** still fly as before; Tab still captures the mouse.

If something feels off, the bindings screen's sliders change it at once; **Export** saves your set to send back.

What would indicate a bug: a button that acts twice (two pads connected, see step 2), a menu press that also acts in flight (for example ✕ on the start screen raising the gear), the throttle creeping with the stick centered (raise the throttle's deadzone and tell me the value), or no toast at all after pressing a button (try another USB port, or pair it again).

## Verification

- **Unit tests** (`tests/inputLayer.test.ts`, 24): deadzones, curves, inversion, sensitivity; the cross-talk guard; throttle as a rate with the detent, the afterburner hold, the stop at military on the way down and both snaps (and slow pushes that are no taps); codes, names, chords and their release; no conflicts in the default layouts; the gamepad source's connect, presses, half-axis hysteresis, disconnect, merging and rumble; profile persistence, reset, export, import and refusal; the jet and the helicopter on a synthetic pad; spatial menu navigation; a press consumed by a menu; padlock angles; buffet.
- **Scripted flight** (`tests/gamepadFlight.test.ts`): the test pilot's takeoff with afterburner, rectangular circuit at 1,000 m and landing in the touchdown zone, with every control passing through a fake pad and the input layer: right stick, left stick (rudder, throttle as a rate, brakes at idle), ✕ for the gear, the parking brake released by the throttle push. It lands within the zone with a sink rate under 2.5 m/s.
- **Browser session** (`node tools/gamepad.session.mjs`, with `npm run dev` up): the real `FreeFlight` class in headless Chromium with a synthetic pad behind `navigator.getGamepads()`: the prompt before the first press, the toast, the start screen by D-pad and ✕, a takeoff on the sticks with afterburner, free look and its spring-back, the pause menu by D-pad, the bindings screen (device tabs by R1, closed by ○), display focus by L1 + Share, the master mode by D-pad, and a disconnect that lets go of the trigger. It found two bugs that are fixed: the ✕ that flew from the start screen also raised the gear, and the jet's look did not spring back.
- **Unchanged:** the full unit suite (171 files) before the menus, the targeted suites after, `tools/freeflight.session.mjs` (every weather preset, pause, takeoff rolls), the type check and lint. The Kestrel's lockstep test is untouched (no flight-model change).
- **Not verified here:** a physical DualShock 4 and real rumble (the session's pad is synthetic), Bluetooth behavior, and Part I acceptance checks 12–14 for the bindings screen and the HUD's throttle bar (`tools/displays.screens.mjs` does not show them yet). I compared screenshots of the bindings screen and pause menu with Part I's UI rules (dark panel, monospaced type, amber highlights, square corners).

## Decisions

- 360: Proposal 0014 accepted, out of sync; decisions numbered from 360 to avoid collisions with the parallel session.
- 361: one code vocabulary; actions out; the keys stay with their owners but resolve through registered tables.
- 362: axis tuning and the left stick's cross-talk guard.
- 363: throttle as a rate, the detent, the afterburner hold, snaps, brakes and parking brake on the throttle stick, the HUD bar.
- 364: the Gamepad API source, merging, joysticks, the connect prompt and toasts.
- 365: profiles per device and class, persistence, export and import.
- 366: the default Mode 2 layout in full, including the helicopter's attitude-command cyclic and the yaw-on-bumpers variant.
- 367: menus and display focus by pad, the bindings screen, rumble; a press a menu used starts no action.

## Shared Files Touched

Outside the new `src/ui/input/`, these existing files changed (lines added / removed against `main`):

| File | Change |
|---|---|
| `src/ui/flight/flightInput.ts` | Registers its key table; gamepad actions and axes from the layer (stick, rudder, throttle as a rate, brakes, look, spring-back); mouse side buttons; `onMessage`; new actions `secondary`, `countermeasures`, `padlock` with no key |
| `src/ui/flight/heloInput.ts` | The same for the helicopter; `update(dt)` takes the frame time (defaults to 1/60) |
| `src/ui/displays/bindings.ts`, `system.ts` | New hot actions (`pageLeft`, `pageRight`, `weaponNext`, `masterArm`, `displayFocus`) with no key; gamepad actions; display focus |
| `src/ui/flight/flightCards.ts` | Help rows skip actions with no key and list the pad's layout when one is connected; **Controls and gamepad…** and the pad's status in the pause menu; cards as menu roots |
| `src/ui/flight/freeFlightMenu.ts` | Focusable airbase rows, **Controls and gamepad…**, the pad's status, the start screen as a menu root |
| `src/ui/flight/hud.ts` | The throttle bar while a pad is connected (+21) |
| `src/ui/missionSearch/panel.ts` | Share toggles it on the map; a menu root (+9) |
| `src/freeflight/freeFlight.ts` | Input glue only (+49 −2): HUD messages from the throttle, padlock, the countermeasures message, rumble hooks, `heloInput.update(dt)`, the gamepad UI's install and the display focus hint |
| `src/follow/follow.ts` | Input glue only (+19): the pad's global actions while following, throttle messages, the gamepad UI's install |
| Docs | `CLAUDE.md` (directory map, commands), `README.md`, `TODO.md`, `docs/decisions.md`, `docs/design.md`, `docs/visual-style.md` (HUD throttle bar), `docs/roadmap.md` (R6.5, out-of-sync section), the proposal and the plan |

`freeFlight.ts` and `follow.ts` are where the parallel session works; the edits there are small and local (constructor wiring, the action switch, the look block after `input.update`, the gun's trigger block), so a rebase should conflict little if at all.

## Known Gaps

- The campaign's taken-over jet has no padlock, countermeasures message or rumble yet (Free Flight has them); the spectator's free look is still the mouse's.
- The time controls and the map's camera have no pad bindings.
- Secondary release, countermeasures and the cargo hook are reserved until R3 and R4.
- No presets for specific flight sticks; WebHID stays for R6.5.
- The default tunings (deadzones, expo, the 2 s idle-to-military rate, the 0.5 s afterburner hold, the 0.4 guard) are first guesses awaiting your hands on a real pad.
