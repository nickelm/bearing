# Plan: Input Layer and Gamepad

_Proposal 0014 (`docs/proposals/0014-input-layer-and-gamepad.md`), decisions 360–367. Out of sync with the roadmap; brings forward R6.5's gamepad buttons and key remapping. Branch `feature/input-layer`._

## Survey: Where Input Is Read Today

| Place | What it reads | Notes |
|---|---|---|
| `src/ui/flight/flightInput.ts` | keydown/keyup/blur on `window`; mousemove on `document`; pointerdown, wheel, contextmenu on the canvas; pointerup on `window`; `navigator.getGamepads()` in `update()` | The jet's input. One key table, `FLIGHT_BINDINGS`; basic gamepad: axes 0/1 stick, 2 twist, 3 throttle (non-standard devices only), button 7 brakes. Used by Free Flight and by follow's taken-over jet. |
| `src/ui/flight/heloInput.ts` | the same events, its own table `HELO_BINDINGS` | Fly-by-mouse helicopter input into a `HeloCommand`. No gamepad. |
| `src/ui/flight/mouseCapture.ts` | `pointerlockchange` | Pointer lock, one owner (rule 14). Unchanged. |
| `src/ui/displays/system.ts` | keydown on `window`, `DISPLAY_BINDINGS` | Display hot keys (1–4, M, F, K, L, U, [ and ]). |
| `src/ui/displays/draw/displaysView.ts` | clicks on bezel buttons, tabs, strip | Mouse only; buttons are DOM elements. |
| `src/follow/follow.ts` | keydown (T, Escape, M, N, C, V); pointer drag and wheel for spectator free look | Spectating a campaign flight. |
| `src/ui/missionSearch/panel.ts` | keydown M; Enter and Space on list items | The mission search panel. |
| `src/ui/timeControls.ts` | keydown Space, Digit1–5 | Campaign time rate. |
| `src/ui/flight/freeFlightMenu.ts` | clicks and keys in the start screen's form | Airbase picker. |
| `src/ui/flight/flightCards.ts` | clicks in the pause menu, help and summary cards | Help lists `FLIGHT_BINDINGS`. |
| `src/ui/touchControls.ts`, `src/render/common/orbitCamera.ts`, `src/render/strategic/strategicScene.ts`, `src/effectsSandbox/main.ts`, `src/ui/audio/weatherAudio.ts` | pointer, wheel and keys for the map and orbit cameras; audio unlock | Camera navigation of the map, not flight. Out of scope for this pass; listed for a later one. |

## Architecture

A new module, `src/ui/input/`:

- **`codes.ts`.** One vocabulary of input codes as strings, so a binding table is `Record<Action, string[]>` for every device: keyboard `KeyboardEvent.code` (`KeyW`), mouse side buttons `Mouse3`/`Mouse4`, gamepad buttons `Pad0`–`Pad17` (W3C standard mapping), half axes as buttons `Axis2+`/`Axis2-`, and chords `Pad4&Pad12` (hold the first, press the second). Display names per controller family (PlayStation ✕ ○ □ △ L1 R1, Xbox A B X Y LB RB, generic).
- **`axis.ts`.** Pure axis tuning: scaled deadzone, response curve (expo), inversion, sensitivity, and the left stick's cross-talk guard (axial deadzones, each grown by the other axis's deflection).
- **`throttleRate.ts`.** The throttle as a rate with the military detent, the afterburner hold, and double-tap snaps to military and idle. Pure state machine.
- **`gamepad.ts`.** `GamepadSource`: polls `navigator.getGamepads()` once per animation frame (its own `requestAnimationFrame` loop; tests call `poll()`), turns button and half-axis changes into press and release events of codes, merges every connected pad, tracks connect and disconnect, and plays rumble. One shared instance, `gamepads()`.
- **`bindings.ts`.** Action resolution with chords: a press of `Pad12` while `Pad4` is held fires the chord's action, not the plain one; a release ends the action its press started.
- **`profiles.ts`.** Default profiles per device kind (keyboard, gamepad with standard mapping, joystick) and aircraft class (fixed-wing, rotary), stored in `localStorage` (`bearing.input.v1`), export and import as JSON. Keyboard profiles write into the existing tables (`FLIGHT_BINDINGS`, `HELO_BINDINGS`, `DISPLAY_BINDINGS`), so every reader of those tables keeps working.
- **`layer.ts`.** `InputLayer`: the active aircraft class, the gamepad profile's action events (press, release, held) and tuned axes (`pitch`, `roll`, `yaw`, `throttle`, `cyclicPitch`, `cyclicRoll`, `pedals`, `collective`, `lookX`, `lookY`), merged over devices.
- **`menuNav.ts`.** Gamepad navigation of DOM menus: registered roots (pause menu, start screen, mission search, bindings screen, displays in focus mode), spatial D-pad focus, ✕/A activates, ○/B goes back (an Escape key event, so every menu closes as it does by keyboard), bumpers switch tabs or step selects, visible focus ring.
- **`prompt.ts`.** The "press any button" status line and connect and disconnect toasts.
- **`bindingsScreen.ts`.** Press-to-bind, axis tuning with a live monitor, profile export and import, layout options.
- **`rumble.ts`.** Effects for gun fire, hits, touchdown and stall buffet.

Consumers keep their public interfaces. `FlightInput`, `HeloInput` and `DisplaySystem` take the gamepad's action events and axes from the layer next to their keys. The keyboard still arrives through each consumer's own listener, because its gating (`enabled`, the pause key under a menu, `preventDefault` only while flying) is per consumer and tested; the keys resolve through the layer's tables (decision 361).

## Phases

1. **Survey and plan.** This document and the proposal.
2. **Input layer.** `codes`, `axis`, `bindings`, `profiles`, `layer`; keyboard tables loaded from the stored profile; mouse side buttons bindable. Existing tests pass unchanged.
3. **Gamepad.** `GamepadSource`, the default Mode 2 layout for both classes, throttle-as-rate with snaps and the afterburner hold, axial deadzones, the look modifier, padlock, the helicopter's cyclic, collective and pedals, the HUD's throttle bar while a pad is connected, the connect prompt.
4. **Menus.** `MenuNav` over the pause menu, the start screen's airbase list, mission search, the bindings screen, and the displays' bezel buttons in display focus mode.
5. **Bindings screen.** From the pause menu and the start screen.
6. **Rumble.** `vibrationActuator.playEffect('dual-rumble')` where the browser has it.
7. **Verification and report.** Unit tests; a scripted test that flies the Kestrel through a takeoff and a landing from synthetic gamepad input; README; decisions; `docs/reports/input-layer-report.md`.

## Shared Files

The input module is new. These existing files change, kept to the input paths: `src/ui/flight/flightInput.ts`, `src/ui/flight/heloInput.ts`, `src/ui/flight/hud.ts` (throttle bar), `src/ui/flight/flightCards.ts` (Controls button, help rows), `src/ui/flight/freeFlightMenu.ts` (focusable rows, Controls button, prompt), `src/ui/displays/bindings.ts` and `system.ts` (new hot actions, gamepad events), `src/ui/missionSearch/panel.ts`, `src/follow/follow.ts` and `src/freeflight/freeFlight.ts` (padlock, rumble hooks only), the docs and the README.
