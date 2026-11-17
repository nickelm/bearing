/**
 * The moving map's picture (Proposal 0006, decision 201): the strategic scene
 * drawn straight down into a square render target a few times a second and read
 * back into plain RGBA pixels, which the map format's screen draws, turned and
 * shifted each frame for track-up and the aircraft's motion between pictures.
 * The target is wider than the screen by √2, so a turned picture still fills it.
 */
import { RenderTarget, SRGBColorSpace, UnsignedByteType } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import type { StrategicScene } from './strategicScene';

export interface MapPicture {
  width: number;
  height: number;
  /** RGBA, rows from the top, sRGB. */
  pixels: Uint8ClampedArray;
  /** The center and the half extent (m, center to edge) it was drawn for. */
  lat: number;
  lon: number;
  halfExtent: number;
}

export class MovingMap {
  private target: RenderTarget | null = null;
  private busy = false;

  constructor(
    private readonly scene: StrategicScene,
    private readonly renderer: WebGPURenderer,
    /** The picture's side in pixels. */
    public size = 512,
  ) {}

  /**
   * Draws the map over (`lat`, `lon`) covering `halfExtent` m from the center to the
   * edge, and reads it back; null while an earlier picture is still being read.
   */
  async picture(lat: number, lon: number, halfExtent: number): Promise<MapPicture | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const n = this.size;
      if (!this.target || this.target.width !== n) {
        this.target?.dispose();
        this.target = new RenderTarget(n, n, { type: UnsignedByteType, depthBuffer: true });
        this.target.texture.colorSpace = SRGBColorSpace;
      }
      this.scene.renderMap(this.target, lat, lon, halfExtent);
      const raw = (await this.renderer.readRenderTargetPixelsAsync(this.target, 0, 0, n, n)) as
        Uint8Array | Uint8ClampedArray;
      return {
        width: n,
        height: n,
        pixels: new Uint8ClampedArray(raw.buffer, raw.byteOffset, n * n * 4),
        lat,
        lon,
        halfExtent,
      };
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
  }
}
