/**
 * Three's WebGPURenderer on Dawn in Node (decision 32): renders into an
 * offscreen render target that three treats as screen output, so tone mapping
 * and the sRGB conversion apply exactly as on the canvas, and reads it back.
 *
 * Three only creates a canvas context when it draws to the canvas itself, so a
 * stub canvas is enough. Its animation loop wants requestAnimationFrame, which
 * Node lacks; a context that never schedules a frame stands in.
 */
import { LinearSRGBColorSpace, RenderTarget, UnsignedByteType, WebGPURenderer } from 'three/webgpu';

export interface HeadlessRenderer {
  readonly renderer: WebGPURenderer;
  readonly width: number;
  readonly height: number;
  /** Reads the last frame as RGB bytes, top row first. */
  readRgb(): Promise<Uint8Array>;
  dispose(): void;
}

/** `width` must be a multiple of 64 (texture readback rows are 256-byte aligned). */
export async function headlessRenderer(
  device: GPUDevice,
  width: number,
  height: number,
): Promise<HeadlessRenderer> {
  if (width % 64 !== 0) throw new Error('headless width must be a multiple of 64');
  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    addEventListener() {},
    removeEventListener() {},
  };
  const renderer = new WebGPURenderer({
    device,
    canvas: canvas as unknown as HTMLCanvasElement,
    antialias: false,
    // As in the app (decision 112).
    reversedDepthBuffer: true,
  });
  await renderer.init();
  const animation = (renderer as unknown as { _animation: { setContext(c: unknown): void } })
    ._animation;
  animation.setContext({ requestAnimationFrame: () => 0, cancelAnimationFrame() {} });

  const target = new RenderTarget(width, height, { type: UnsignedByteType, depthBuffer: true });
  // The renderer already encodes its output to sRGB in the shader, as for a canvas. An
  // sRGB target would encode again in hardware, so the bytes would be encoded twice
  // (every preview too pale before decision 100). The target stores the shader's bytes.
  target.texture.colorSpace = LinearSRGBColorSpace;
  renderer.setOutputRenderTarget(target);
  renderer.setRenderTarget(target);

  return {
    renderer,
    width,
    height,
    async readRgb() {
      const rgba = (await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        width,
        height,
      )) as Uint8Array;
      const rgb = new Uint8Array(width * height * 3);
      for (let i = 0; i < width * height; i++) {
        rgb[i * 3] = rgba[i * 4]!;
        rgb[i * 3 + 1] = rgba[i * 4 + 1]!;
        rgb[i * 3 + 2] = rgba[i * 4 + 2]!;
      }
      return rgb;
    },
    dispose() {
      target.dispose();
      renderer.dispose();
    },
  };
}
