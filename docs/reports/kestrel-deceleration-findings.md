# Kestrel deceleration: findings (decision 207, step 1)

The owner reported that the F-21 Kestrel is hard to slow down on a straight-in approach: the speedbrake seems to do little, and the gear "refuses to extend" because the jet stays above its 300 KIAS limit. This note records what the headless diagnostic found before any tuning.

**Tool:** `npx vitest run --config vitest.tools.config.ts tools/decel.preview.ts --disable-console-intercept`. It flies the real `FlightModel` through the flight director, level at 1,500 m with the throttle at idle, at landing weight (internal fuel down to 1,000 kg, 11.1 t). The drag breakdown comes from a new telemetry field, `FlightTelemetry.drag`, which holds the terms the model sums into CD (same order of summation, so the lockstep fixture still passes). The fixtures live in `tests/helpers/decel.ts`, shared with the tests of step 2.

## The verdict in brief

The model has no bug that blocks the gear or holds the speed up. In level flight it decelerates at or faster than the targets: 450 → 300 KIAS with the speedbrake takes 22 s (target 20–40 s) and 300 → 170 KIAS with gear and speedbrake 28 s (target 30–60 s). The scripted straight-in approach of step 4 already passes on the old model; the jet is below 300 KIAS 18.9 km out.

What the player meets is gravity and weight, without a cue:

1. **A descent cancels most of the speedbrake.** At idle with the speedbrake out, deceleration falls from 6.0 kt/s level to 2.4 kt/s on a 10° descent at 350 KIAS, and to 0.3 kt/s at 250 KIAS. A pilot who points the nose at a runway from high up, as mouse aim invites, holds speed with the speedbrake open.
2. **Free Flight flies heavy forever.** With unlimited fuel (the default) the jet keeps its full 3,200 kg of fuel, 13.3 t, so it decelerates about 15% more slowly than at landing weight and its on-speed approach speed is 164 KCAS, outside the 135–155 KCAS target.
3. **Nothing on the HUD says whether the deceleration is enough.** There is no speed trend, no gear-limit marker and no approach speed bug, so the player finds out at the gear warning.

## The suspects

| # | Suspect | Applies? | Evidence |
|---|---|---|---|
| 1 | Gear limit units or speed type | **No** | `gear.maxSpeed` is 154.3 m/s (299.9 kt) and is compared with calibrated airspeed in m/s (`outcomes.ts`, `flightWarnings`). Nothing refuses the gear handle: the model moves the gear at any speed, and the only check raises the GEAR SPEED warning. |
| 2 | Idle thrust too high | **Partly** | Lever 0 reaches the idle table (no detent above it). Idle is 6% of military at sea level, Mach 0, which is plausible, but it stays at 2,570 N (4% of military) at Mach 0.72, 1,500 m, where the target asks for nearly zero once ram drag counts. |
| 3 | Engine spool-down | **No** (slightly fast) | Military → idle reaches 95% of the change in 1.8 s (target 2–4 s); nothing latches. Idle → military takes 5.4 s (target 4–6 s). A fast spool-down helps deceleration, so this is fidelity, not the cause. |
| 4 | Speedbrake drag too small or slow | **No**, but incomplete | ΔCD = 0.050 at full travel, in 2.0 s, and nothing keeps it closed. It adds 4.5 kt/s at 450 KIAS and 0.8 kt/s at 160 KIAS. Missing: deflection in degrees, its drag's dependence on deflection, the 43° limit with the gear down and the pitch moment. |
| 5 | Induced drag missing or too small | **No**: too large near 13° | k = 0.13 (AR 3.2, e ≈ 0.76) is right at low α, but the separate `cdAlpha·sin²α` term adds 0.05 at 13°, so L/D at on-speed α with gear and speedbrake is 3.6 (target 5–8). High-α drag rises too slowly above 20°. Clean CD0 = 0.0175 is below the 0.020–0.025 target. |
| 6 | Gear drag missing | **No** | ΔCD = 0.020 for the gear and 0.010 for the flaps (which follow the gear handle), both proportional to gear position in transit. Gear transit is 6 s (target 3–5 s). |
| 7 | Flight director or assist adds thrust | **No** | Mouse aim calls the director with `speed: null`, so the throttle stays the player's; the test pilot runs only with `?autopilot`. No speed hold or instructor logic touches the throttle in direct control. |

## Numbers before tuning

Level at 1,500 m, idle, 11.1 t. CD terms are referred to the wing area (27.87 m²).

```
  KIAS gear sb |     q Pa    α°    CL |    CD0   ind   sep  gear  flap    sb |    CD |  drag N  thrust N | kt/s
   450 up   in  |    32183   0.9  0.12 | 0.0175 0.002 0.000 0.000 0.000 0.000 | 0.020 |   17626      2572 |  2.5
   450 up   out |    32176   0.9  0.12 | 0.0175 0.002 0.000 0.000 0.000 0.050 | 0.070 |   62455      2573 | 10.0
   450 down in  |    32181  -0.4  0.12 | 0.0175 0.002 0.000 0.020 0.010 0.000 | 0.049 |   44273      2572 |  7.0
   450 down out |    32184  -0.4  0.12 | 0.0175 0.002 0.000 0.020 0.010 0.050 | 0.099 |   89174      2572 | 14.5
   350 up   in  |    19607   2.0  0.20 | 0.0175 0.005 0.001 0.000 0.000 0.000 | 0.024 |   13003      2979 |  1.7
   350 up   out |    19607   2.0  0.20 | 0.0175 0.005 0.001 0.000 0.000 0.050 | 0.074 |   40307      2979 |  6.2
   350 down in  |    19607   0.6  0.19 | 0.0175 0.005 0.000 0.020 0.010 0.000 | 0.053 |   28697      2979 |  4.2
   350 down out |    19604   0.6  0.19 | 0.0175 0.005 0.000 0.020 0.010 0.050 | 0.102 |   55989      2979 |  8.8
   250 up   in  |    10062   4.5  0.39 | 0.0175 0.019 0.006 0.000 0.000 0.000 | 0.043 |   12071      3389 |  1.4
   250 up   out |    10062   4.5  0.39 | 0.0175 0.019 0.006 0.000 0.000 0.050 | 0.093 |   26092      3389 |  3.7
   250 down in  |    10062   3.2  0.38 | 0.0175 0.019 0.003 0.020 0.010 0.000 | 0.070 |   19585      3389 |  2.6
   250 down out |    10062   3.0  0.37 | 0.0175 0.018 0.003 0.020 0.010 0.050 | 0.119 |   33255      3389 |  4.9
   160 up   in  |     4138  12.4  0.93 | 0.0175 0.112 0.046 0.000 0.000 0.000 | 0.176 |   20260      3624 |  2.6
   160 up   out |     4137  12.0  0.91 | 0.0175 0.107 0.043 0.000 0.000 0.050 | 0.218 |   25153      3624 |  3.4
   160 down in  |     4138  10.6  0.92 | 0.0175 0.110 0.034 0.020 0.010 0.000 | 0.192 |   22089      3624 |  2.9
   160 down out |     4137  10.3  0.90 | 0.0175 0.105 0.032 0.020 0.010 0.050 | 0.235 |   27099      3624 |  3.7
```

On a descending path at 2,500 m, idle, speedbrake out, gear up (kt/s at 11.1 t, with 13.3 t in brackets):

```
   450 KIAS    0°:  9.6 ( 8.2)    -3°:  8.5 ( 7.0)    -6°:  7.3 ( 5.8)   -10°:  5.7 ( 4.2)   kt/s at 11.1 t (13.3 t)
   350 KIAS    0°:  6.0 ( 5.2)    -3°:  4.9 ( 4.1)    -6°:  3.8 ( 3.0)   -10°:  2.4 ( 1.6)   kt/s at 11.1 t (13.3 t)
   250 KIAS    0°:  3.6 ( 3.4)    -3°:  2.6 ( 2.5)    -6°:  1.6 ( 1.5)   -10°:  0.3 ( 0.1)   kt/s at 11.1 t (13.3 t)
```

| Target | Before |
|---|---|
| 450 → 300 KIAS, 1,500 m, idle, speedbrake open | 22.0 s (20–40) |
| 300 → 170 KIAS, idle, speedbrake (no 43° limit: 60°), gear down | 27.8 s (30–60) **fails: too fast** |
| L/D at 13°, gear down, speedbrake | 3.6 (5–8) **fails** |
| Thrust on a 3° path at 13°, gear down, speedbrake | 23.2 kN vs idle 3.7 kN (clearly above idle) |
| Idle glide at 13°, gear down | 11.8° (steeper than 5°; the first run of the tool gave 7.8° from a glide that had not settled at 13°) |
| On-speed approach speed | 150 KCAS at 11.1 t (135–155); 164 KCAS at Free Flight's 13.3 t |
| Spool-down / spool-up | 1.8 s (2–4) / 5.4 s (4–6) |
| Gear / speedbrake transit | 6.0 s (3–5) / 2.0 s (1–2) |
| Straight-in, 25 km, 1,500 m, 450 KIAS | below 300 KIAS at 18.9 km, on speed at 13.7 km, touchdown 414 m in, 1.3 m/s |

## What step 2 changes

- Drag: CD0 to about 0.021 subsonic; the separated-flow term becomes a table over α that is zero up to about 13° and rises steeply above 15°; k for e = 0.8; smaller gear and flap increments; a stores term (zero for the standard load, which the CD0 table already holds).
- Idle thrust: a table that reaches zero by Mach 0.7 (ram drag).
- Spool-down 2–4 s; gear transit 4 s; speedbrake 1.5 s.
- Speedbrake in degrees: 60° in flight, 43° with the gear down, drag scaled by deflection, a small nose-up moment the pitch law holds.
- Gear overspeed: the handle always works; GEAR SPEED above 300 KIAS; more than 20 kt over the limit with the gear out damages the doors (gear stays down, extra drag).
- Cues (step 3), since the main finding is that the player cannot see the deceleration.

## After step 2 (decision 207)

| Target | Before | After |
|---|---|---|
| 450 → 300 KIAS, 1,500 m, idle, speedbrake open (20–40 s) | 22.0 s | 23.9 s |
| 300 → 170 KIAS, idle, speedbrake 43°, gear down (30–60 s) | 27.8 s (at 60°: no limit) | 40.3 s |
| L/D at 13°, gear down, speedbrake 43° (5–8) | 3.6 | 5.2 |
| Thrust on a 3° path at 13° (clearly above idle) | 23.2 kN, lever 0.26 (idle 3.7 kN) | 15.0 kN, lever 0.16 (idle 3.1 kN) |
| Idle glide at 13°, gear down (steeper than 5°) | 11.8° | 8.9° |
| On-speed approach speed at landing weight (135–155 KIAS) | 150 | 150 |
| Spool-down / spool-up (2–4 s / 4–6 s) | 1.8 s / 5.4 s | 2.9 s / 5.4 s |
| Gear / speedbrake transit (3–5 s / 1–2 s) | 6.0 s / 2.0 s | 4.0 s / 1.5 s |
| Takeoff: rotation, liftoff roll | 147 KCAS, 570 m | 147 KCAS, 568 m |
| Stall, landing configuration (120–140 KIAS) | 125 | 125 |
| Top speed at 300 m (Mach 1.1–1.2) | 1.122 | 1.122 |
| Straight-in at 11.1 t: under 300 KIAS / on speed / touchdown | 18.9 km / 13.7 km / 414 m, 1.3 m/s | 18.2 km / 10.0 km / 422 m, 1.0 m/s |
| Straight-in at 13.3 t | 17.8 km / 12.8 km / 393 m, 1.5 m/s | 16.9 km / 9.0 km / 392 m, 1.4 m/s |

The jet now decelerates a little more slowly at high speed than before, because the targets asked for less drag near 13°, a 43° speedbrake with the gear down and a lower CD0 ratio at the transonic rise. It still meets every deceleration target. What changes for the player is the cues: the trend vector shows whether the deceleration is enough, the gear marker shows where the limit sits on the tape, and the energy cue says whether idle and speedbrake will make the 5 km gate.

