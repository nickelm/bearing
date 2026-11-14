/**
 * Starts Chromium with WebGPU for tools that run the real app (tools/browser.smoke.mjs),
 * and finds Playwright for the tools that need a browser at all.
 *
 * Playwright is no dependency of the repo. `loadPlaywright` takes it from the repo's
 * node_modules if someone installed it there, from NODE_PATH, from PLAYWRIGHT_DIR (a
 * node_modules directory), or from /opt/node-tools/node_modules (cloud sessions).
 *
 * `launch` opens the app's origin in a persistent profile, so that a world generated once
 * stays in the browser's IndexedDB for the next run. WebGPU comes from one of three places
 * (`mode`):
 *
 * - `gpu`: the machine's own GPU. The default wherever there is a display or the platform
 *   is not Linux. Headless Chromium keeps the GPU on most machines; set HEADED=1 if the
 *   adapter comes out as a software one.
 * - `lavapipe`: Mesa's software Vulkan driver, for machines without a GPU (cloud sessions:
 *   `apt-get install -y mesa-vulkan-drivers`, and gcc). Chromium offers no switch for it, so
 *   a copy of Playwright's Chromium gets tools/browser/lvpshim.c in the place of its
 *   SwiftShader library (see that file). The copy is made of hard links in the OS temp
 *   directory and takes no space. The compositor stays on SwiftShader and cannot show a
 *   canvas that lavapipe drew: the page's screenshot shows the HTML over an empty canvas,
 *   and `capture` in page.mjs reads the frame back through the WebGPU device instead.
 * - `swiftshader`: Chromium's own software fallback. It runs three.js, but not Bearing: the
 *   tile synthesizer's compute kernels never finish, the map stays without relief, and the
 *   GPU process grows by 50 MB a second until the kernel kills it. It is here to show that.
 *
 * The plain headless shell that Playwright starts by default loses the WebGPU device when
 * the canvas presents; all modes therefore start the full Chromium (`channel: 'chromium'`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LAVAPIPE = process.env.LVP_SHIM_LIB ?? '/usr/lib/x86_64-linux-gnu/libvulkan_lvp.so';

/** The `playwright` module, from wherever it is installed. */
export function loadPlaywright() {
  const places = [
    import.meta.url,
    ...(process.env.PLAYWRIGHT_DIR ? [join(process.env.PLAYWRIGHT_DIR, '/')] : []),
    '/opt/node-tools/node_modules/',
  ];
  for (const place of places) {
    try {
      return createRequire(place)('playwright');
    } catch {
      // The next place.
    }
  }
  throw new Error(
    'Playwright is not installed. It is no dependency of the repo: install it anywhere ' +
      '(npm i playwright && npx playwright install chromium) and point PLAYWRIGHT_DIR or ' +
      'NODE_PATH at that node_modules.',
  );
}

/** The mode `launch` takes when none is asked for. */
export function defaultMode() {
  if (process.env.MODE) return process.env.MODE;
  const headlessLinux = process.platform === 'linux' && !process.env.DISPLAY;
  if (!headlessLinux) return 'gpu';
  return existsSync(LAVAPIPE) ? 'lavapipe' : 'swiftshader';
}

const SOFTWARE_FLAGS = [
  '--use-angle=swiftshader',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
];

/**
 * A copy of Playwright's Chromium whose WebGPU runs on lavapipe: hard links to every file
 * but three. Returns the copy's executable. Made once per Chromium build and shim source.
 */
export function lavapipeChromium(chromium) {
  if (!existsSync(LAVAPIPE)) {
    throw new Error(`${LAVAPIPE} is missing: apt-get install -y mesa-vulkan-drivers`);
  }
  const exe = chromium.executablePath();
  const source = dirname(exe);
  const copy = join(tmpdir(), 'bearing-browser', `${basename(dirname(source))}-lavapipe`);
  const stamp = join(copy, 'bearing-lavapipe');
  const target = join(copy, basename(exe));
  if (existsSync(stamp)) return target;
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(dirname(copy), { recursive: true });
  try {
    execFileSync('cp', ['-al', source, copy]);
  } catch {
    // Another file system: a real copy (about 400 MB).
    rmSync(copy, { recursive: true, force: true });
    execFileSync('cp', ['-a', source, copy]);
  }
  // Unlink before writing: the names are hard links to Playwright's own files.
  const lib = join(copy, 'libvk_swiftshader.so');
  const real = join(copy, 'libvk_swiftshader_real.so');
  const icd = join(copy, 'vk_swiftshader_icd.json');
  linkSync(join(source, 'libvk_swiftshader.so'), real);
  rmSync(lib);
  execFileSync('gcc', ['-shared', '-fPIC', '-O1', '-o', lib, join(here, 'lvpshim.c'), '-ldl']);
  // The compositor (ANGLE) finds its Vulkan driver through this file: it keeps SwiftShader.
  rmSync(icd);
  writeFileSync(
    icd,
    JSON.stringify({
      file_format_version: '1.0.0',
      ICD: { library_path: './libvk_swiftshader_real.so', api_version: '1.0.5' },
    }),
  );
  writeFileSync(stamp, new Date().toISOString());
  return target;
}

/**
 * Opens Chromium with WebGPU and returns `{ context, page, mode }`; close the context when
 * done. Options: `mode` (see the file comment; default `defaultMode()`), `profile` (the
 * browser profile's directory; default one per mode in the OS temp directory), `width` and
 * `height` of the viewport, `headed`, `args` (more Chromium switches).
 */
export async function launch(options = {}) {
  const { chromium } = loadPlaywright();
  const mode = options.mode ?? defaultMode();
  const args = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  // Sound starts on the first key or click in the app; a headless page still needs this to
  // let the AudioContext run.
  args.push('--autoplay-policy=no-user-gesture-required');
  const launchOptions = {
    headless: !(options.headed ?? process.env.HEADED === '1'),
    viewport: { width: options.width ?? 640, height: options.height ?? 360 },
    deviceScaleFactor: 1,
  };
  if (mode === 'lavapipe') {
    launchOptions.executablePath = lavapipeChromium(chromium);
    args.push('--no-sandbox', ...SOFTWARE_FLAGS);
  } else if (mode === 'swiftshader') {
    launchOptions.channel = 'chromium';
    args.push('--no-sandbox', ...SOFTWARE_FLAGS);
  } else if (mode === 'gpu') {
    launchOptions.channel = 'chromium';
    if (process.platform === 'linux') args.push('--enable-features=Vulkan');
  } else {
    throw new Error(`Unknown mode "${mode}" (gpu, lavapipe, swiftshader)`);
  }
  args.push(...(options.args ?? []), ...(process.env.ARGS?.split(' ').filter(Boolean) ?? []));
  const profile =
    options.profile ?? process.env.PROFILE ?? join(tmpdir(), 'bearing-browser', `profile-${mode}`);
  mkdirSync(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, { ...launchOptions, args });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, mode };
}
