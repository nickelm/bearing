/**
 * The Kestrel's deceleration, diagnosed (the straight-in approach; decision 207): flies the
 * flight model headless, level at 1,500 m with the throttle at idle, and prints at 450, 350,
 * 250 and 160 KIAS, gear up and down, speedbrake in and out: dynamic pressure, α, CL, the drag
 * coefficient by term, drag and net thrust in newtons and the deceleration in knots per
 * second. Then the engine's spool times, the gear's and speedbrake's transit, and the
 * deceleration and approach targets of tests/flightDecel.test.ts.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/decel.preview.ts --disable-console-intercept
 */
import { test } from 'vitest';
import { DEG, KNOT } from '../src/core/units';
import { speedForAlpha } from '../src/sim/flight/flightDirector';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import {
  decelTime,
  idleGlide,
  levelStart,
  onSpeedPath,
  snapshotAt,
  spoolTime,
  straightInApproach,
} from '../tests/helpers/decel';
import type { ApproachLog } from '../tests/helpers/decel';

const H = 1500;
const f = (x: number, w: number, d = 0) => x.toFixed(d).padStart(w);

test('Kestrel deceleration diagnostic', () => {
  const lines: string[] = [];
  const say = (s = '') => lines.push(s);
  const { m: probe } = levelStart(250 * KNOT, H, { gear: false, speedbrake: false });
  say(`Kestrel deceleration at ${H} m, idle, mass ${probe.mass.toFixed(0)} kg`);
  say(
    '  KIAS gear sb |     q Pa    α°    CL |    CD0   ind   sep  gear  flap    sb |    CD |  drag N  thrust N | kt/s',
  );
  for (const kias of [450, 350, 250, 160]) {
    for (const gear of [false, true]) {
      for (const sb of [false, true]) {
        const { snap } = snapshotAt(kias * KNOT, H, { gear, speedbrake: sb });
        if (!snap) {
          say(`  ${f(kias, 4)} ${gear ? 'down' : 'up  '} ${sb ? 'out' : 'in '} | (no snapshot)`);
          continue;
        }
        const t = snap.terms;
        say(
          `  ${f(kias, 4)} ${gear ? 'down' : 'up  '} ${sb ? 'out' : 'in '}` +
            ` | ${f(snap.qbar, 8)} ${f(snap.alpha / DEG, 5, 1)} ${f(snap.cl, 5, 2)}` +
            ` | ${f(t.cd0, 6, 4)} ${f(t.induced, 5, 3)} ${f(t.separated, 5, 3)} ${f(t.gear, 5, 3)}` +
            ` ${f(t.flaps, 5, 3)} ${f(t.speedbrake, 5, 3)} | ${f(snap.cd, 5, 3)}` +
            ` | ${f(snap.drag, 7)} ${f(snap.thrust, 9)} | ${f(snap.decel / KNOT, 4, 1)}`,
        );
      }
    }
  }
  say();
  say(
    'Deceleration at idle, speedbrake out, gear up, on a descending path (gravity helps the engine):',
  );
  for (const kias of [450, 350, 250]) {
    const row: string[] = [];
    for (const deg of [0, -3, -6, -10]) {
      const light = snapshotAt(
        kias * KNOT,
        2500,
        { gear: false, speedbrake: true },
        12 * KNOT,
        deg * DEG,
      );
      const heavy = snapshotAt(
        kias * KNOT,
        2500,
        { gear: false, speedbrake: true },
        12 * KNOT,
        deg * DEG,
        3200,
      );
      row.push(
        `${f(deg, 3)}°: ${f((light.snap?.decel ?? NaN) / KNOT, 4, 1)} (${f((heavy.snap?.decel ?? NaN) / KNOT, 4, 1)})`,
      );
    }
    say(`  ${f(kias, 4)} KIAS  ${row.join('   ')}   kt/s at 11.1 t (13.3 t)`);
  }
  say();
  const down = spoolTime(0.8, 0);
  const up = spoolTime(0, 0.8);
  say(
    `Spool-down military → idle: ${down.seconds.toFixed(1)} s to 95% (${down.before.toFixed(0)} → ${down.after.toFixed(0)} N)`,
  );
  say(
    `Spool-up idle → military:   ${up.seconds.toFixed(1)} s to 95% (${up.before.toFixed(0)} → ${up.after.toFixed(0)} N)`,
  );
  // Transit times, from the spec's rates, measured on the model.
  {
    const { m, ctl } = levelStart(250 * KNOT, H, { gear: false, speedbrake: false });
    ctl.gearDown = true;
    ctl.speedbrake = true;
    let gearT = 0;
    let sbT = 0;
    for (let i = 1; i < 20 / FLIGHT_STEP && (!gearT || !sbT); i++) {
      m.step(ctl, { height: () => 0, surface: () => 'field' });
      if (!gearT && m.gear >= 0.999) gearT = i * FLIGHT_STEP;
      if (!sbT && m.speedbrake >= 0.999) sbT = i * FLIGHT_STEP;
    }
    say(`Gear extension: ${gearT.toFixed(1)} s; speedbrake opening: ${sbT.toFixed(1)} s`);
    say(
      `Gear limit: ${(m.spec.gear.maxSpeed / KNOT).toFixed(1)} KCAS (spec ${m.spec.gear.maxSpeed} m/s)`,
    );
  }
  say();
  const a = decelTime(450 * KNOT, 300 * KNOT, H, { gear: false, speedbrake: true });
  const b = decelTime(300 * KNOT, 170 * KNOT, H, { gear: true, speedbrake: true });
  const c = decelTime(450 * KNOT, 300 * KNOT, H, { gear: false, speedbrake: false });
  say(`450 → 300 KIAS, idle, speedbrake out:            ${a.seconds.toFixed(1)} s (target 20–40)`);
  say(`450 → 300 KIAS, idle, speedbrake in:             ${c.seconds.toFixed(1)} s`);
  say(`300 → 170 KIAS, idle, speedbrake out, gear down: ${b.seconds.toFixed(1)} s (target 30–60)`);
  const app = onSpeedPath(-3 * DEG);
  say(
    `On-speed (13°) 3° path, gear down, sb out: L/D ${app.ld.toFixed(2)} (target 5–8), ` +
      `thrust ${app.thrust.toFixed(0)} N vs idle ${app.idleThrust.toFixed(0)} N, ` +
      `lever ${app.lever.toFixed(2)}, ${(app.cas / KNOT).toFixed(0)} KCAS, α ${(app.alpha / DEG).toFixed(1)}°`,
  );
  const appClean = onSpeedPath(-3 * DEG, 13 * DEG, false);
  say(
    `On-speed (13°) 3° path, gear down, sb in:  L/D ${appClean.ld.toFixed(2)}, ` +
      `thrust ${appClean.thrust.toFixed(0)} N, lever ${appClean.lever.toFixed(2)}`,
  );
  const glide = idleGlide();
  say(
    `Idle glide at 13°, gear down, sb in: ${(-glide.gamma / DEG).toFixed(1)}° (target steeper than 5°), ` +
      `${(glide.cas / KNOT).toFixed(0)} KCAS`,
  );
  const { m: heavy } = levelStart(150 * KNOT, H, { gear: true, speedbrake: false }, 3200);
  const { m: light } = levelStart(150 * KNOT, H, { gear: true, speedbrake: false });
  say(
    `On-speed approach speed (13°, gear down): ${(speedForAlpha(light) / KNOT).toFixed(0)} KCAS at ` +
      `${light.mass.toFixed(0)} kg (target 135–155); ${(speedForAlpha(heavy) / KNOT).toFixed(0)} KCAS at ${heavy.mass.toFixed(0)} kg`,
  );
  say();
  const km = (x: number | null) => (x === null ? '—' : `${(x / 1000).toFixed(1)} km`);
  const approach = (label: string, a: ApproachLog) => {
    say(`Straight-in approach, ${label}: 25 km, 1,500 m, 450 KIAS`);
    say(
      `  below 300 KIAS at ${km(a.below300At)} (target ≥ 12 km), gear down at ${km(a.gearDownAt)}, ` +
        `on speed (final) at ${km(a.onSpeedAt)}, speedbrake with gear ${(a.sbWithGear * 60).toFixed(0)}°`,
    );
    const s5 = a.at5km;
    if (s5)
      say(
        `  at 5 km: ${(s5.cas / KNOT).toFixed(0)} KIAS (approach ${(s5.approachSpeed / KNOT).toFixed(0)}), ` +
          `α ${(s5.alpha / DEG).toFixed(1)}°, ${s5.deviation.toFixed(0)} m off the glide path, ` +
          `sink ${s5.sink.toFixed(1)} m/s; 5–2 km: |α − 13°| ≤ ${(s5.alphaSpread / DEG).toFixed(1)}°, ` +
          `|deviation| ≤ ${s5.deviationSpread.toFixed(0)} m`,
      );
    const td = a.touchdown;
    say(
      td
        ? `  touchdown ${td.distance?.toFixed(0)} m past the threshold, sink ${td.sinkRate.toFixed(2)} m/s, ` +
            `${(td.speed / KNOT).toFixed(0)} KIAS, in zone: ${td.inZone}; phase ${a.phase}`
        : `  no touchdown; phase ${a.phase}, crashed: ${a.crashed}`,
    );
    say(
      '  km:   ' +
        a.track
          .filter(([d]) => d % 2 === 1 || d <= 5)
          .map(
            ([d, v, h, al, th, g]) =>
              `${d}:${v.toFixed(0)}kt/${h.toFixed(0)}m/α${al.toFixed(0)}/t${th.toFixed(2)}${g > 0.99 ? 'G' : ''}`,
          )
          .join(' '),
    );
  };
  approach('landing weight', straightInApproach());
  approach('Free Flight weight (3,200 kg fuel)', straightInApproach(3200));
  console.log('\n' + lines.join('\n'));
});
