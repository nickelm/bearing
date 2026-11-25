# Proposal 0014: Input Layer and Gamepad

Bearing is a cartoony browser game; the values and systems here serve gameplay (README.md, What Bearing Is; CLAUDE.md rule 22).

*Drafted 2026-11-23. Status: accepted (decision 360). Runs out of sync with the roadmap, beside R2; it brings forward the gamepad and key remapping of R6.5. Plan: `docs/plans/input-layer.md`.*

## Decision

All input goes through an input layer that turns devices (keyboard, mouse, gamepads, and later flight sticks, throttles, and pedals) into named actions and axes. Game code, the flight director, cursor mode, crew menus, and the event log see only actions, never devices. Gamepads get a default Mode 2 layout, shared by jets and helicopters.

## Input Layer

- **Actions and axes:** pitch, roll, yaw, throttle, collective, look, weapon fire, secondary release, countermeasures, target cycle, master modes, display buttons, padlock, pause, and every other existing binding.
- **Bindings:** any action binds to any key, mouse input, button, or axis. A press-to-bind screen captures inputs. Profiles are saved per device and per aircraft class (fixed-wing, rotary), with export and import.
- **Axis tuning:** deadzones (per axis, see below), response curves, inversion, and sensitivity.
- **Multiple devices:** several connected devices merge into one control set.
- **Device source:** the browser Gamepad API, polled once per frame. Show a "press any button" prompt, since browsers hide gamepads until a button is pressed. Handle connect and disconnect at any time.
- **Event log:** the log records actions, so replays work regardless of device.

## Default Gamepad Layout (Mode 2)

| Control | Fixed-wing | Helicopter |
|---|---|---|
| Right stick | Pitch and roll | Cyclic |
| Left stick, vertical | Throttle as a rate: pushing moves the throttle, releasing holds it | Collective; in the Assisted preset a climb-rate command, centered holds altitude |
| Left stick, horizontal | Rudder | Pedals; centered engages heading hold through pedal trim |
| Right trigger | Fire selected weapon | Fire selected weapon |
| Left trigger | Release or launch secondary | Release or launch secondary |
| Hold left bumper + right stick | Free look; releasing springs back | Free look |
| Right stick click | Padlock current target; click again to release | Padlock |
| Right bumper | Countermeasures | Countermeasures |
| D-pad | Master modes and display pages | Master modes and display pages |
| Face buttons | Target cycle, weapon select, gear, speedbrake | Target cycle, weapon select, hover hold, hook |
| Start / Select | Pause menu / mission search | Pause menu / mission search |

**Throttle details:** a throttle bar on the HUD shows the stored throttle. Double-tapping the left stick up snaps to military power; double-tapping down snaps to idle. Afterburner requires pushing past military with a short hold.

**Cross-talk guards on the left stick:** axial deadzones per axis, so sideways wobble during collective changes and vertical wobble during yaw are ignored. Each axis must be pushed deliberately to register. An option moves yaw to the bumpers as a digital input that ramps the longer it is held.

**Menus by gamepad:** mission search, pause menu, displays, and crew menus are navigable with the D-pad, face buttons, and bumpers, with visible focus.

**Rumble (optional):** gun fire, hits, touchdown, and stall buffet on gamepads that support vibration.

## Later: Flight Stick, Throttle, and Pedals

The same layer handles HOTAS gear through generic bindings and presets for common models. Pedals provide rudder and toe brakes (differential braking in Free Flight). In helicopters, the throttle axis becomes the collective. A stick's hat switch replaces the look modifier. WebHID is a later fallback for devices the Gamepad API reports incompletely.
