/**
 * The bindings screen (Proposal 0014, decision 367): every action of the keyboard and mouse,
 * the gamepad and the joystick, per aircraft class, rebindable by pressing the input; the
 * analog axes with their tuning and a live monitor; profile export and import. Opened from
 * the pause menu and the start screen; navigable by gamepad itself.
 *
 * - **Press to bind.** "Bind" waits for the next key, mouse side button, gamepad button or
 *   axis push; a button pressed while another is held makes a chord ("L1 + D-pad ↑"). Escape
 *   (or a few seconds of nothing) cancels.
 * - **Axes.** Each analog control picks its device axis (or "Detect": push the stick), its
 *   inversion, deadzone, curve and sensitivity, and shows the raw and the tuned value live.
 */
import { tuneAxis } from './axis';
import type { AxisTuning } from './axis';
import { conflicts } from './bindings';
import { axisName, bindingName, codeKind } from './codes';
import type { PadEvent, DeviceKind } from './gamepad';
import { inputLayer } from './layer';
import { registerNavRoot } from './menuNav';
import { padStatusLine } from './prompt';
import { AXES, AXIS_LABELS, defaultGamepad } from './profiles';
import type { AircraftClass, AxisId, AxisSetting, PadProfile } from './profiles';
import { ACTION_LABELS } from '../flight/flightInput';
import { HELO_LABELS } from '../flight/heloInput';
import { DISPLAY_LABELS } from '../displays/bindings';

type Device = 'keyboard' | DeviceKind;

const GLOBAL_LABELS: Record<string, string> = {
  missionSearch: 'Mission search (campaign map)',
  takeControl: 'Take control of the followed aircraft',
  handBack: 'Hand the aircraft back to its pilot',
  backToMap: 'Back to the map (following)',
  nextAircraft: 'Next aircraft of the flight (following)',
  nextPanels: 'Displays on or off (following)',
  recenterView: 'Recenter the view (following)',
};

const EXTRA_LABELS: Record<string, string> = {
  fire: 'Fire the selected weapon',
  secondary: 'Release or launch the secondary weapon (reserved until R3)',
  countermeasures: 'Countermeasures (reserved until R3)',
  padlock: 'Padlock the locked target; again to release',
  hook: 'Cargo hook (reserved until R4)',
  yawLeft: 'Rudder left',
  yawRight: 'Rudder right',
  pedalLeft: 'Pedal left',
  pedalRight: 'Pedal right',
};

function labelsFor(cls: AircraftClass): Record<string, string> {
  return {
    ...EXTRA_LABELS,
    ...(cls === 'fixed' ? ACTION_LABELS : HELO_LABELS),
    ...DISPLAY_LABELS,
  };
}

/** Actions a class's gamepad can bind: its key actions, the displays', and the pad's own. */
function padActions(cls: AircraftClass): string[] {
  const keys = Object.keys(cls === 'fixed' ? ACTION_LABELS : HELO_LABELS).filter(
    (a) => !['mouseAim', 'mouseCapture', 'invertMouse', 'debug'].includes(a),
  );
  const own =
    cls === 'fixed'
      ? ['fire', 'secondary', 'countermeasures', 'padlock']
      : ['fire', 'secondary', 'countermeasures', 'padlock', 'hook'];
  return [...new Set([...own, ...keys, ...Object.keys(DISPLAY_LABELS)])];
}

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...children);
  return el;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class BindingsScreen {
  readonly el = h('div', { className: 'ff-panel ff-card pad-bindings' });
  private device: Device = 'gamepad';
  private cls: AircraftClass = 'fixed';
  private readonly body = h('div');
  private readonly monitor: { raw: HTMLDivElement; tuned: HTMLDivElement; id: AxisId }[] = [];
  private readonly pressed = h('div', { className: 'ff-note' });
  private raf = 0;
  private cancelBind: (() => void) | null = null;
  private readonly layer = inputLayer();

  constructor() {
    Object.assign(this.el.style, {
      zIndex: '40',
      // Opaque enough to read over the pause menu it opens from.
      background: 'rgb(14 16 18 / 0.95)',
      maxHeight: 'calc(100vh - 32px)',
      overflowY: 'auto',
      width: 'min(56rem, calc(100vw - 32px))',
    });
    this.el.hidden = true;
    document.body.append(this.el);
    this.el.append(this.body);
    registerNavRoot(this.el, {
      priority: 50,
      back: () => (this.cancelBind ? this.cancelBind() : (this.visible = false)),
      tab: (d) => this.cycleDevice(d),
    });
    // Escape closes this screen only, not the pause menu under it.
    window.addEventListener(
      'keydown',
      (e) => {
        if (this.el.hidden || e.code !== 'Escape' || this.cancelBind) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        this.visible = false;
      },
      { capture: true },
    );
    this.layer.onRaw((e) => {
      if (this.el.hidden || (e.type !== 'press' && e.type !== 'release')) return;
      const held = this.layer.source.connected.length;
      this.pressed.textContent = held
        ? `Last input: ${bindingName(e.code, this.layer.source.family)} ${e.type === 'press' ? 'pressed' : 'released'}`
        : '';
    });
    this.layer.source.on((e) => {
      if (!this.el.hidden && (e.type === 'connect' || e.type === 'disconnect')) this.render();
    });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  set visible(v: boolean) {
    if (v === this.visible) return;
    this.el.hidden = !v;
    this.cancelBind?.();
    if (v) {
      this.cls = this.layer.aircraftClass;
      this.device = this.layer.source.has('gamepad')
        ? 'gamepad'
        : this.layer.source.has('joystick')
          ? 'joystick'
          : this.device;
      this.render();
      this.tick();
    } else cancelAnimationFrame(this.raf);
  }

  private cycleDevice(d: 1 | -1): void {
    const order: Device[] = ['keyboard', 'gamepad', 'joystick'];
    this.device = order[(order.indexOf(this.device) + d + order.length) % order.length]!;
    this.render();
  }

  private tick = (): void => {
    for (const m of this.monitor) {
      const s = this.profile().axes[m.id];
      const kind = this.device === 'keyboard' ? 'gamepad' : this.device;
      const raw = s && s.axis >= 0 ? this.layer.source.axis(s.axis, kind) : 0;
      const tuned = s ? tuneAxis(raw, s) : 0;
      bar(m.raw, raw);
      bar(m.tuned, tuned);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private profile(): PadProfile {
    const kind: DeviceKind = this.device === 'joystick' ? 'joystick' : 'gamepad';
    return this.layer.store.pad(kind, this.cls);
  }

  private savePad(p: PadProfile): void {
    const kind: DeviceKind = this.device === 'joystick' ? 'joystick' : 'gamepad';
    this.layer.store.setPad(kind, this.cls, p);
  }

  render(): void {
    this.monitor.length = 0;
    const tabs = h('div', { className: 'ff-buttons pad-row' });
    const tab = (label: string, on: boolean, fn: () => void) => {
      const b = h('button', { textContent: label, className: on ? 'ff-primary' : '' });
      b.addEventListener('click', fn);
      return b;
    };
    tabs.append(
      tab('Keyboard and mouse', this.device === 'keyboard', () => this.set('keyboard', this.cls)),
      tab('Gamepad', this.device === 'gamepad', () => this.set('gamepad', this.cls)),
      tab('Joystick', this.device === 'joystick', () => this.set('joystick', this.cls)),
      h('span', { textContent: '·' }),
      tab('Jets', this.cls === 'fixed', () => this.set(this.device, 'fixed')),
      tab('Helicopters', this.cls === 'rotary', () => this.set(this.device, 'rotary')),
    );
    const head = h(
      'div',
      {},
      h('h1', { textContent: 'Controls' }),
      padStatusLine(),
      h('div', {
        className: 'ff-note',
        textContent:
          'Gamepad: the D-pad moves, ✕ / A presses, ○ / B goes back, L1 / R1 switch the device. Bind waits for the next key, button or stick push; hold a button and press another for a chord.',
      }),
      tabs,
      this.pressed,
    );
    const content =
      this.device === 'keyboard' ? this.keyboardSection() : this.padSection(this.device);
    this.body.replaceChildren(head, ...content, this.footer());
  }

  private set(device: Device, cls: AircraftClass): void {
    this.device = device;
    this.cls = cls;
    this.render();
  }

  // ---- Keyboard ----

  private keyboardSection(): HTMLElement[] {
    const store = this.layer.store;
    const out: HTMLElement[] = [];
    const sections: [string, string][] = [
      [this.cls === 'fixed' ? 'fixed' : 'rotary', this.cls === 'fixed' ? 'Jets' : 'Helicopters'],
      ['displays', 'Displays (both)'],
    ];
    for (const [name, title] of sections) {
      const table = store.keyTable(name);
      if (!table) {
        out.push(
          h('div', {
            className: 'ff-note',
            textContent: `${title}: start a flight once to load these bindings.`,
          }),
        );
        continue;
      }
      const labels: Record<string, string> =
        name === 'displays' ? DISPLAY_LABELS : labelsFor(this.cls);
      const clash = conflicts(table);
      const rows = Object.keys(table).map((a) =>
        this.row(
          labels[a] ?? a,
          table[a] ?? [],
          (b) => bindingName(b),
          clash,
          (codes) => {
            store.setKeys(name, a, codes);
            this.render();
          },
          'keyboard',
        ),
      );
      out.push(h('h2', { textContent: title }), h('table', {}, ...rows));
    }
    out.push(
      h('div', {
        className: 'ff-note',
        textContent:
          'The mouse keeps its roles: left button fires when captured, right button looks, middle recenters, the wheel is the throttle. Its side buttons bind like keys.',
      }),
    );
    return out;
  }

  // ---- Gamepad and joystick ----

  private padSection(kind: DeviceKind): HTMLElement[] {
    const p = clone(this.profile());
    const family = this.layer.source.family;
    const labels = labelsFor(this.cls);
    const clash = conflicts(p.buttons);
    const actions = [...new Set([...padActions(this.cls), ...Object.keys(p.buttons)])];
    const rows = actions.map((a) =>
      this.row(
        labels[a] ?? a,
        p.buttons[a] ?? [],
        (b) => bindingName(b, family),
        clash,
        (codes) => {
          p.buttons[a] = codes;
          this.savePad(p);
          this.render();
        },
        kind,
      ),
    );
    const out: HTMLElement[] = [h('h2', { textContent: 'Axes' }), this.axesTable(p, kind)];
    out.push(this.optionsBlock(p, kind));
    out.push(h('h2', { textContent: 'Buttons' }), h('table', {}, ...rows));
    if (kind === 'gamepad') {
      const g = { ...this.layer.store.global('gamepad') };
      const gc = conflicts(g);
      const grow = Object.keys(GLOBAL_LABELS).map((a) =>
        this.row(
          GLOBAL_LABELS[a]!,
          g[a] ?? [],
          (b) => bindingName(b, family),
          gc,
          (codes) => {
            g[a] = codes;
            this.layer.store.data.global.gamepad = g;
            this.layer.store.save();
            this.render();
          },
          kind,
        ),
      );
      out.push(h('h2', { textContent: 'Campaign and following' }), h('table', {}, ...grow));
    }
    return out;
  }

  private axesTable(p: PadProfile, kind: DeviceKind): HTMLTableElement {
    const rows: HTMLTableRowElement[] = [];
    for (const id of AXES[this.cls]) {
      const s: AxisSetting = p.axes[id] ?? {
        axis: -1,
        invert: false,
        deadzone: 0.1,
        curve: 0,
        sensitivity: 1,
      };
      const save = (o: Partial<AxisSetting>) => {
        p.axes[id] = { ...s, ...o };
        this.savePad(p);
      };
      const pick = h('select', { title: 'Which axis of the device' });
      for (let i = -1; i < 8; i++)
        pick.append(h('option', { value: String(i), textContent: axisName(i) }));
      pick.value = String(s.axis);
      pick.addEventListener('change', () => {
        save({ axis: Number(pick.value) });
        this.render();
      });
      const detect = h('button', {
        textContent: 'Detect',
        title: 'Push the stick or lever you want',
      });
      detect.addEventListener('click', () =>
        this.capture(
          detect,
          (code) => {
            if (codeKind(code) !== 'axis') return false;
            save({ axis: Number(code.slice(4, -1)) });
            return true;
          },
          kind,
          true,
        ),
      );
      const inv = h('input', { type: 'checkbox', checked: s.invert, title: 'Invert' });
      inv.addEventListener('change', () => save({ invert: inv.checked }));
      const slider = (
        key: 'deadzone' | 'curve' | 'sensitivity',
        min: number,
        max: number,
        st: number,
      ) => {
        const r = h('input', {
          type: 'range',
          min: String(min),
          max: String(max),
          step: String(st),
        });
        r.value = String(s[key]);
        const lab = h('span', { textContent: s[key].toFixed(2) });
        r.addEventListener('input', () => {
          lab.textContent = Number(r.value).toFixed(2);
          save({ [key]: Number(r.value) } as Partial<AxisTuning>);
          Object.assign(s, { [key]: Number(r.value) });
        });
        return h(
          'label',
          { title: key },
          `${key === 'deadzone' ? 'dz' : key === 'curve' ? 'curve' : 'sens'} `,
          r,
          ' ',
          lab,
        );
      };
      const cells: (Node | string)[] = [
        pick,
        ' ',
        detect,
        ' ',
        h('label', {}, inv, ' invert'),
        ' ',
        slider('deadzone', 0, 0.6, 0.01),
        ' ',
        slider('curve', 0, 1, 0.05),
        ' ',
        slider('sensitivity', 0.2, 2, 0.05),
      ];
      if (id === 'throttle' || id === 'collective') {
        const mode = h('select', {
          title: 'A centering stick as a rate, or a lever as a position',
        });
        mode.append(
          h('option', { value: 'rate', textContent: 'as a rate' }),
          h('option', { value: 'absolute', textContent: 'as a lever' }),
        );
        mode.value = s.mode ?? 'rate';
        mode.addEventListener('change', () => save({ mode: mode.value as 'rate' | 'absolute' }));
        cells.push(' ', mode);
      }
      const raw = h('div');
      const tuned = h('div');
      this.monitor.push({ raw, tuned, id });
      rows.push(
        h(
          'tr',
          {},
          h(
            'td',
            { title: 'Live: the raw axis (top) and the tuned value (bottom)' },
            AXIS_LABELS[id],
            meter(raw),
            meter(tuned),
          ),
          h('td', {}, ...cells),
        ),
      );
    }
    return h('table', {}, ...rows);
  }

  private optionsBlock(p: PadProfile, kind: DeviceKind): HTMLElement {
    const box = h('div');
    const guard = h('input', { type: 'range', min: '0', max: '0.8', step: '0.05' });
    guard.value = String(p.options.crossGuard);
    const gl = h('span', { textContent: p.options.crossGuard.toFixed(2) });
    guard.addEventListener('input', () => {
      gl.textContent = Number(guard.value).toFixed(2);
      p.options.crossGuard = Number(guard.value);
      this.savePad(p);
    });
    box.append(
      h(
        'label',
        {
          title:
            "Each left-stick axis ignores the other's wobble: this share of the other axis's deflection is added to its deadzone",
        },
        'Left stick cross-talk guard ',
        guard,
        ' ',
        gl,
      ),
    );
    if (kind === 'gamepad') {
      const bumpers = h('input', { type: 'checkbox', checked: p.options.yawOnBumpers });
      bumpers.addEventListener('change', () => {
        // The bumper layout moves the look modifier and its chords to L3: the layout's defaults.
        const fresh = defaultGamepad(this.cls, bumpers.checked);
        fresh.axes = {
          ...p.axes,
          [this.cls === 'fixed' ? 'yaw' : 'pedals']:
            fresh.axes[this.cls === 'fixed' ? 'yaw' : 'pedals'],
        };
        fresh.options = { ...p.options, yawOnBumpers: bumpers.checked };
        this.savePad(fresh);
        this.render();
      });
      const rumble = h('input', { type: 'checkbox', checked: p.options.rumble });
      rumble.addEventListener('change', () => {
        p.options.rumble = rumble.checked;
        this.savePad(p);
      });
      const test = h('button', { textContent: 'Test rumble' });
      test.addEventListener('click', () => {
        const ok = this.layer.source.rumble(0.8, 0.4, 300);
        test.textContent = ok ? 'Test rumble' : 'Test rumble (this pad or browser has none)';
      });
      box.append(
        h('br'),
        h(
          'label',
          { title: 'L1 and R1 yaw, ramping while held; free look and the chords move to L3' },
          bumpers,
          ' Yaw on the bumpers (resets the button layout)',
        ),
        h('br'),
        h('label', {}, rumble, ' Rumble'),
        ' ',
        test,
      );
    }
    return box;
  }

  /** One action's row: its bindings as removable chips, Bind and Clear. */
  private row(
    label: string,
    list: readonly string[],
    name: (b: string) => string,
    clash: Map<string, string[]>,
    set: (codes: string[]) => void,
    device: Device,
  ): HTMLTableRowElement {
    const chips = h('td');
    for (const b of list) {
      const shared = clash.get(b);
      const chip = h('button', {
        textContent: `${name(b)} ×`,
        title: shared ? `Also bound to: ${shared.join(', ')}. Click to remove.` : 'Click to remove',
      });
      if (shared) chip.style.color = '#ffb347';
      chip.addEventListener('click', () => set(list.filter((x) => x !== b)));
      chips.append(chip, ' ');
    }
    const bind = h('button', { textContent: 'Bind' });
    bind.addEventListener('click', () =>
      this.capture(
        bind,
        (code) => {
          set([...list.filter((x) => x !== code), code]);
          return true;
        },
        device,
        false,
      ),
    );
    return h('tr', {}, h('td', { textContent: label }), chips, h('td', {}, bind));
  }

  /**
   * Waits for the next input of `device` and hands its code to `take` (false: keep waiting).
   * Gamepad buttons bind on release, or as a chord when a second one is pressed while held.
   */
  private capture(
    btn: HTMLButtonElement,
    take: (code: string) => boolean,
    device: Device,
    axesOnly: boolean,
  ): void {
    this.cancelBind?.();
    const before = btn.textContent;
    btn.textContent =
      device === 'keyboard' ? 'Press a key…' : axesOnly ? 'Push the axis…' : 'Press…';
    let first: string | null = null;
    const finish = () => {
      window.removeEventListener('keydown', key, { capture: true });
      window.removeEventListener('pointerdown', mouse, { capture: true });
      this.layer.capture = null;
      clearTimeout(timer);
      this.cancelBind = null;
      btn.textContent = before;
    };
    const done = (code: string) => {
      if (take(code)) {
        finish();
        this.render();
      }
    };
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape' || device !== 'keyboard') {
        if (e.code === 'Escape') finish();
        return;
      }
      done(e.code);
    };
    const mouse = (e: PointerEvent) => {
      if (device !== 'keyboard' || e.button < 3) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      done(`Mouse${e.button}`);
    };
    const pad = (e: PadEvent) => {
      if (device === 'keyboard' || (e.type !== 'press' && e.type !== 'release')) return;
      if (e.kind !== device) return;
      const kind = codeKind(e.code);
      if (axesOnly) {
        if (e.type === 'press' && kind === 'axis') done(e.code);
        return;
      }
      if (e.type === 'press') {
        if (kind === 'axis') {
          // A half axis as a button (a hat or a trigger reported as an axis).
          if (first === null) done(e.code);
          return;
        }
        if (first === null) first = e.code;
        else done(`${first}&${e.code}`);
      } else if (e.code === first) done(first);
    };
    window.addEventListener('keydown', key, { capture: true });
    window.addEventListener('pointerdown', mouse, { capture: true });
    this.layer.capture = pad;
    const timer = setTimeout(finish, 8000);
    this.cancelBind = finish;
  }

  private footer(): HTMLElement {
    const store = this.layer.store;
    const area = h('textarea', {
      rows: 4,
      placeholder: 'Exported profiles appear here; paste one to import it.',
    });
    Object.assign(area.style, {
      width: '100%',
      boxSizing: 'border-box',
      font: 'inherit',
      fontSize: '11px',
    });
    const msg = h('span', { className: 'ff-note' });
    const b = (label: string, fn: () => void) => {
      const el = h('button', { textContent: label });
      el.addEventListener('click', fn);
      return el;
    };
    const file = h('input', { type: 'file', accept: '.json,application/json' });
    file.hidden = true;
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (!f) return;
      void f.text().then((t) => importText(t));
    });
    const importText = (t: string) => {
      try {
        store.import(t);
        msg.textContent = 'Imported.';
        this.render();
      } catch (e) {
        msg.textContent = `Not imported: ${(e as Error).message}`;
      }
    };
    return h(
      'div',
      {},
      h('h2', { textContent: 'Profiles' }),
      h(
        'div',
        { className: 'ff-buttons pad-row' },
        b(
          `Reset ${this.device === 'keyboard' ? 'the keys' : `this ${this.device}`} to defaults`,
          () => {
            store.reset(this.device, this.device === 'keyboard' ? undefined : this.cls);
            this.render();
          },
        ),
        b('Export', () => {
          const json = store.export();
          area.value = json;
          try {
            const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
            const a = h('a', { href: url, download: 'bearing-controls.json' });
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            msg.textContent = 'Saved as bearing-controls.json, and shown below.';
          } catch {
            msg.textContent = 'Shown below; copy it.';
          }
        }),
        b('Import from file…', () => file.click()),
        b('Import the text below', () => importText(area.value)),
        b('Close', () => (this.visible = false)),
        file,
      ),
      msg,
      area,
    );
  }
}

function meter(fill: HTMLDivElement): HTMLDivElement {
  const box = h('div');
  Object.assign(box.style, {
    position: 'relative',
    width: '90px',
    height: '6px',
    margin: '3px 0',
    background: 'rgb(255 255 255 / 0.12)',
  });
  Object.assign(fill.style, { position: 'absolute', top: '0', bottom: '0', background: '#ffb347' });
  box.append(fill);
  return box;
}

/** A centered meter's fill for v in −1..1. */
function bar(fill: HTMLDivElement, v: number): void {
  const w = Math.min(1, Math.abs(v)) * 50;
  fill.style.left = `${v < 0 ? 50 - w : 50}%`;
  fill.style.width = `${w}%`;
}

let screen: BindingsScreen | null = null;

/** Opens the bindings screen (one per page). */
export function openBindings(): void {
  screen ??= new BindingsScreen();
  screen.visible = true;
}
