/**
 * The gamepad's presence on screen (Proposal 0014, decision 364): browsers hide a gamepad
 * until one of its buttons is pressed, so the start screen, the pause menu and the bindings
 * screen carry a status line that asks for a press until one is seen; a toast reports every
 * connect and disconnect, whenever it happens.
 */
import { gamepads } from './gamepad';
import type { PadInfo } from './gamepad';
import { installMenuNav } from './menuNav';

const FAMILY: Record<PadInfo['family'], string> = {
  playstation: 'PlayStation layout',
  xbox: 'Xbox layout',
  generic: 'standard layout',
};

/** A short name for a pad: the id up to its first parenthesis ("Wireless Controller"). */
export function padName(info: PadInfo): string {
  const n = info.id.replace(/\s*\(.*$/, '').trim() || info.id;
  return n.length > 40 ? `${n.slice(0, 39)}…` : n;
}

/** The status line's text for the pads connected now. */
export function statusText(pads: readonly PadInfo[]): string {
  if (pads.length === 0)
    return 'Gamepad: none seen yet. Connect it (USB or Bluetooth) and press any button on it.';
  return pads
    .map((p) =>
      p.kind === 'gamepad'
        ? `Gamepad: ${padName(p)} (${FAMILY[p.family]}${p.rumble ? ', rumble' : ''})`
        : `Joystick: ${padName(p)}`,
    )
    .join(' · ');
}

/** A live status line to put into a menu. */
export function padStatusLine(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ff-note pad-status';
  const src = gamepads();
  const show = () => (el.textContent = statusText(src.connected));
  show();
  src.on((e) => {
    if (e.type === 'connect' || e.type === 'disconnect') show();
  });
  return el;
}

let installed = false;

/** The connect and disconnect toasts and gamepad menu navigation, once per page. */
export function installGamepadUi(): void {
  if (installed || typeof document === 'undefined' || !document.body) return;
  installed = true;
  installMenuNav();
  const toast = document.createElement('div');
  toast.className = 'ff-panel pad-toast';
  toast.hidden = true;
  Object.assign(toast.style, {
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '60',
    pointerEvents: 'none',
  });
  document.body.append(toast);
  let timer: ReturnType<typeof setTimeout> | null = null;
  gamepads().on((e) => {
    if (e.type !== 'connect' && e.type !== 'disconnect') return;
    toast.textContent =
      e.type === 'connect'
        ? `${e.info.kind === 'gamepad' ? 'Gamepad' : 'Joystick'} connected: ${padName(e.info)}`
        : `${e.info.kind === 'gamepad' ? 'Gamepad' : 'Joystick'} disconnected: ${padName(e.info)}`;
    toast.hidden = false;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => (toast.hidden = true), 3500);
  });
}
