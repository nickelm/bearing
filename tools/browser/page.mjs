/**
 * What tools/browser.smoke.mjs puts into the app's page and asks of it: a probe that
 * records WebGPU errors, device loss, frames and audio contexts, and helpers that read the
 * frame back, work the debug panel and the Free Flight menus as a user would, and report
 * the scene's state through the handle the app sets with `?dev` (`window.bearing`,
 * src/main.ts).
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

/**
 * Puts a world written by tools/browser.world.preview.ts (`prefix`.json and .bin) into the
 * world cache of the app at `app`, unless the cache has it: the app then loads the world as
 * one it generated before. Returns what it did, for the log.
 */
export async function importWorld(page, app, prefix) {
  const json = readFileSync(`${prefix}.json`);
  const size = statSync(`${prefix}.bin`).size;
  const file = openSync(`${prefix}.bin`, 'r');
  // The files reach the page through its own origin (a page may not fetch from another
  // local port), in pieces: one response of 200 MB is more than the route can carry.
  const pattern = '**/__world/**';
  await page.route(pattern, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/page.html')) {
      return route.fulfill({
        body: '<!doctype html><title>world</title>',
        contentType: 'text/html',
      });
    }
    if (url.pathname.endsWith('/world.json')) {
      return route.fulfill({ body: json, contentType: 'application/json' });
    }
    const at = Number(url.searchParams.get('at'));
    const piece = Buffer.alloc(Math.min(Number(url.searchParams.get('bytes')), size - at));
    readSync(file, piece, 0, piece.length, at);
    return route.fulfill({ body: piece, contentType: 'application/octet-stream' });
  });
  try {
    await page.goto(new URL('__world/page.html', app).href);
    return await page.evaluate(async (total) => {
      const request = (r) =>
        new Promise((resolve, reject) => {
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      // The database of worldgen/worldStore.ts.
      const open = indexedDB.open('bearing-worlds', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('worlds', { keyPath: 'key' });
      const db = await request(open);
      const tree = await (await fetch('world.json')).json();
      const stored = await request(db.transaction('worlds').objectStore('worlds').getKey(tree.key));
      if (stored !== undefined) {
        db.close();
        return `world ${tree.key}: in the browser's cache`;
      }
      const bin = new Uint8Array(total);
      const PIECE = 16 << 20;
      for (let at = 0; at < total; at += PIECE) {
        const piece = await (await fetch(`world.bin?at=${at}&bytes=${PIECE}`)).arrayBuffer();
        bin.set(new Uint8Array(piece), at);
      }
      const build = (v) => {
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(build);
        if ('$array' in v)
          return new globalThis[v.$array](bin.buffer.slice(v.offset, v.offset + v.bytes));
        if ('$bigint' in v) return BigInt(v.$bigint);
        if ('$number' in v) return Number(v.$number);
        if ('$undefined' in v) return undefined;
        if ('$map' in v) return new Map(v.$map.map(([k, x]) => [build(k), build(x)]));
        if ('$set' in v) return new Set(v.$set.map(build));
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, build(x)]));
      };
      const transaction = db.transaction('worlds', 'readwrite');
      transaction.objectStore('worlds').put(build(tree));
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
      db.close();
      return `world ${tree.key}: put into the browser's cache (${(total / 2 ** 20).toFixed(0)} MiB)`;
    }, size);
  } finally {
    await page.unroute(pattern);
    closeSync(file);
  }
}

/** Runs in the page before the app's scripts (page.addInitScript). */
export function probe() {
  const g = (window.__probe = {
    gpuErrors: [],
    lost: null,
    device: null,
    config: null,
    audio: [],
    frames: 0,
    intervals: [],
    lastFrame: -1,
    lastTime: 0,
    texture: null,
    textureFrame: -1,
    textureCanvas: null,
    wanted: null,
    flashWanted: false,
    flash: null,
    thunder: 0,
  });
  if (typeof GPUAdapter !== 'undefined') {
    const requestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await requestDevice.apply(this, args);
      g.device = device;
      device.addEventListener('uncapturederror', (e) => {
        g.gpuErrors.push(e.error.message);
        console.error(`[probe] WebGPU error: ${e.error.message}`);
      });
      void device.lost.then((info) => {
        g.lost = `${info.reason || 'unknown'}: ${info.message}`;
        console.error(`[probe] WebGPU device lost: ${g.lost}`);
      });
      return device;
    };
    const getCurrentTexture = GPUCanvasContext.prototype.getCurrentTexture;
    GPUCanvasContext.prototype.getCurrentTexture = function () {
      const texture = getCurrentTexture.call(this);
      g.texture = texture;
      g.textureFrame = g.lastFrame;
      g.textureCanvas = this.canvas;
      return texture;
    };
    const configure = GPUCanvasContext.prototype.configure;
    GPUCanvasContext.prototype.configure = function (c) {
      g.config = { format: c.format, alphaMode: c.alphaMode ?? 'opaque' };
      return configure.call(this, c);
    };
  }
  if (typeof AudioContext !== 'undefined') {
    const Original = AudioContext;
    window.AudioContext = class extends Original {
      constructor(...args) {
        super(...args);
        g.audio.push(this);
      }
    };
  }

  /**
   * The frame the app has just drawn, read back through the device as the page would
   * composite it (premultiplied alpha over the page's background), with the 2D canvases
   * (the HUD) over it. HTML is not in it: that is the page's own screenshot.
   */
  g.readback = (resolve) => {
    const device = g.device;
    const texture = g.texture;
    const { width, height } = texture;
    const rowBytes = Math.ceil((width * 4) / 256) * 256;
    const buffer = device.createBuffer({
      size: rowBytes * height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: rowBytes }, [width, height]);
    device.queue.submit([encoder.finish()]);
    // Not offsetParent: it is null for a fixed canvas, as the HUD's is.
    const others = [...document.querySelectorAll('canvas')].filter((c) => {
      if (c === g.textureCanvas || c.width === 0) return false;
      const style = getComputedStyle(c);
      return style.display !== 'none' && style.visibility !== 'hidden' && c.getClientRects().length;
    });
    buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        const source = new Uint8Array(buffer.getMappedRange());
        const image = new ImageData(width, height);
        const bgra = texture.format.startsWith('bgra');
        const premultiplied = g.config?.alphaMode === 'premultiplied';
        const match = /rgba?\((\d+), (\d+), (\d+)/.exec(
          getComputedStyle(document.body).backgroundColor,
        );
        const background = match
          ? [Number(match[1]), Number(match[2]), Number(match[3])]
          : [0, 0, 0];
        let alphaMin = 255;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const i = y * rowBytes + x * 4;
            const o = (y * width + x) * 4;
            const a = source[i + 3];
            alphaMin = Math.min(alphaMin, a);
            const color = [source[i + (bgra ? 2 : 0)], source[i + 1], source[i + (bgra ? 0 : 2)]];
            for (let k = 0; k < 3; k++) {
              image.data[o + k] = premultiplied
                ? Math.min(255, color[k] + ((255 - a) * background[k]) / 255)
                : color[k];
            }
            image.data[o + 3] = 255;
          }
        }
        buffer.unmap();
        buffer.destroy();
        const frame = document.createElement('canvas');
        frame.width = width;
        frame.height = height;
        frame.getContext('2d').putImageData(image, 0, 0);
        const out = document.createElement('canvas');
        out.width = innerWidth;
        out.height = innerHeight;
        const context = out.getContext('2d');
        context.drawImage(frame, 0, 0, out.width, out.height);
        for (const c of others) {
          const r = c.getBoundingClientRect();
          context.drawImage(c, r.left, r.top, r.width, r.height);
        }
        // The mean color, and the share of pixels that differ from the capture before by
        // more than the film grain does: two numbers that tell whether the picture moved.
        const all = context.getImageData(0, 0, out.width, out.height).data;
        const mean = [0, 0, 0];
        let differ = 0;
        const before = g.previous?.length === all.length ? g.previous : null;
        for (let i = 0; i < all.length; i += 4) {
          let d = 0;
          for (let k = 0; k < 3; k++) {
            mean[k] += all[i + k];
            if (before) d = Math.max(d, Math.abs(all[i + k] - before[i + k]));
          }
          if (d > 8) differ++;
        }
        g.previous = all;
        resolve({
          png: out.toDataURL('image/png'),
          size: `${width}x${height}`,
          alphaMin,
          mean: mean.map((v) => Math.round(v / (all.length / 4))),
          changed: before ? differ / (all.length / 4) : null,
        });
      },
      (e) => resolve({ error: String(e) }),
    );
  };

  // Frames are counted, and captures taken, right after the app's own frame callback.
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    raf((t) => {
      const now = performance.now();
      if (t !== g.lastFrame) {
        if (g.lastTime) {
          g.intervals.push(now - g.lastTime);
          if (g.intervals.length > 600) g.intervals.shift();
        }
        g.lastTime = now;
        g.lastFrame = t;
        g.frames++;
      }
      callback(t);
      if (g.textureFrame !== t || !g.texture) return;
      const flash = window.bearing?.globe.weatherState.flash.value ?? 0;
      if (g.flashWanted && flash > 0.05) {
        g.flashWanted = false;
        g.readback((r) => (g.flash = { ...r, flash }));
      } else if (g.wanted) {
        const resolve = g.wanted;
        g.wanted = null;
        g.readback(resolve);
      }
    });

  /** A control of the debug panel (lil-gui) by its label. */
  const control = (name) =>
    [...document.querySelectorAll('.lil-gui .lil-controller')].find(
      (c) => c.querySelector('.lil-name')?.textContent === name,
    );
  g.guiGet = (name) => {
    const input = control(name)?.querySelector('select, input');
    if (!input) return null;
    return input.type === 'checkbox' ? input.checked : input.value;
  };
  g.guiSet = (name, value) => {
    const c = control(name);
    if (!c) return `no control "${name}"`;
    const select = c.querySelector('select');
    const input = c.querySelector('input');
    if (select) {
      const i = [...select.options].findIndex((o) => o.textContent === String(value));
      if (i < 0) return `"${name}" has no option "${value}"`;
      select.selectedIndex = i;
      select.dispatchEvent(new Event('change'));
    } else if (input?.type === 'checkbox') {
      if (input.checked !== Boolean(value)) input.click();
    } else if (input) {
      input.value = String(value);
      input.dispatchEvent(new Event('input'));
    } else {
      return `"${name}" cannot be set`;
    }
    return 'ok';
  };

  /** The scene's state, from the app's handle. */
  g.state = () => {
    const b = window.bearing;
    if (!b) return null;
    const scene = b.globe;
    const w = scene.weatherState;
    const r = (x) => +x.toFixed(3);
    const recent = g.intervals.slice(-10);
    const audio = b.audio;
    const ambience = audio.ambience;
    const heading = (node) => ambience.targets.get(node.gain) ?? node.gain.value;
    return {
      flight: b.freeFlight?.state ?? null,
      gameTime: Math.round(scene.gameTime),
      paused: scene.paused,
      clock: r(w.clock.value),
      scale: b.renderScale.scale,
      governor: b.governor.level,
      quality: b.atmosphere.status,
      rain: r(w.rain.value),
      snow: r(w.snow.value),
      dust: r(w.dust.value),
      storm: r(w.storm.value),
      fogPerKm: r(w.fog.value * 1000),
      wetness: r(w.wetness.value),
      particles: scene.precipitation ? { ...scene.precipitation.counts } : null,
      passes: scene.pipeline?.stats.passes ?? 0,
      tilesDrawn: scene.terrain.stats.drawn,
      tilesPending: scene.terrain.stats.pending,
      sunElevation: r(scene.lighting.sunElevation * 57.29578),
      frames: g.frames,
      frameMs: recent.length ? Math.round(recent.reduce((a, x) => a + x, 0) / recent.length) : null,
      thunder: g.thunder,
      audio: audio.context
        ? {
            state: audio.context.state,
            master: r(audio.master.gain.value),
            // The gains now, and the levels they are heading for.
            rain: r(ambience.patter.gain.value + ambience.roar.gain.value),
            wind: r(ambience.wind.gain.value),
            dust: r(ambience.hiss.gain.value),
            target: {
              rain: r(heading(ambience.patter) + heading(ambience.roar)),
              wind: r(heading(ambience.wind)),
              dust: r(heading(ambience.hiss)),
            },
            thunders: audio.thunders.map((t) => ({ end: r(t.end), gain: r(t.gain) })),
          }
        : null,
    };
  };

  /** Counts the thunder the lightning hands to the sound (call once the handle exists). */
  g.countThunder = () => {
    const lightning = window.bearing.globe.lightning;
    const forward = lightning.onThunder;
    lightning.onThunder = (strike) => {
      g.thunder++;
      forward?.(strike);
    };
  };
}

/** The scene's state (see `probe`), or null without the app's handle. */
export const state = (page) => page.evaluate(() => window.__probe.state());

/** Sets a control of the debug panel by its label; throws if there is none. */
export async function gui(page, name, value) {
  const result = await page.evaluate(([n, v]) => window.__probe.guiSet(n, v), [name, value]);
  if (result !== 'ok') throw new Error(result);
}

/** Sets a select or a slider of the page (the Free Flight menus) and fires its events. */
export async function choose(page, selector, value) {
  const found = await page.evaluate(
    ([q, v]) => {
      const e = document.querySelector(q);
      if (!e) return false;
      e.value = String(v);
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    [selector, value],
  );
  if (!found) throw new Error(`Nothing matches ${selector}`);
}

/** Clicks the visible button with this label. */
export async function button(page, label) {
  const found = await page.evaluate((text) => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.textContent.trim() === text && x.offsetParent !== null,
    );
    b?.click();
    return Boolean(b);
  }, label);
  if (!found) throw new Error(`No visible button "${label}"`);
}

/**
 * The next frame the app draws, as `{ png (a Buffer), size, alphaMin, mean, changed }`: read
 * back through the WebGPU device, which works whatever draws the page (see launch.mjs).
 * `changed` is the share of pixels that differ from the capture before by more than grain.
 */
export async function capture(page, timeout = 120_000) {
  const result = await Promise.race([
    page.evaluate(() => new Promise((resolve) => (window.__probe.wanted = resolve))),
    new Promise((resolve) => setTimeout(() => resolve({ error: 'no frame was drawn' }), timeout)),
  ]);
  if (result.error) throw new Error(`Capture failed: ${result.error}`);
  return { ...result, png: Buffer.from(result.png.split(',')[1], 'base64') };
}

/** Waits for a frame with a lightning flash and returns it as `capture` does, or null. */
export async function captureFlash(page, timeout) {
  await page.evaluate(() => {
    window.__probe.flash = null;
    window.__probe.flashWanted = true;
  });
  try {
    await page.waitForFunction(() => window.__probe.flash, null, { timeout, polling: 250 });
  } catch {
    await page.evaluate(() => (window.__probe.flashWanted = false));
    return null;
  }
  const result = await page.evaluate(() => window.__probe.flash);
  if (result.error) throw new Error(`Capture failed: ${result.error}`);
  return { ...result, png: Buffer.from(result.png.split(',')[1], 'base64') };
}
