/** The decision to stop before starting on a software WebGPU adapter (webgpuSupport.ts). */
import { describe, expect, it } from 'vitest';
import { isSoftwareAdapter, softwareAdapterNotice } from '../src/render/common/webgpuSupport';

const query = (s: string) => new URLSearchParams(s);

describe('the software-adapter notice', () => {
  it('knows a software adapter by either place browsers say so', () => {
    expect(isSoftwareAdapter({ info: { isFallbackAdapter: true } })).toBe(true);
    expect(isSoftwareAdapter({ isFallbackAdapter: true })).toBe(true);
    expect(
      isSoftwareAdapter({ info: { isFallbackAdapter: false }, isFallbackAdapter: false }),
    ).toBe(false);
    // Browsers that say nothing have handed out a real adapter.
    expect(isSoftwareAdapter({})).toBe(false);
    expect(isSoftwareAdapter({ info: {} })).toBe(false);
  });

  it('stops the start on a software adapter, in the campaign and in Free Flight', () => {
    const swiftshader = { info: { isFallbackAdapter: true } };
    expect(softwareAdapterNotice(swiftshader, query(''))).toBe(true);
    expect(softwareAdapterNotice(swiftshader, query('?seed=1983&dev'))).toBe(true);
    expect(softwareAdapterNotice(swiftshader, query('?mode=freeflight&base=4&weather=storm'))).toBe(
      true,
    );
  });

  it('starts at once on hardware, and on a software adapter when the URL asks for it', () => {
    const hardware = { info: { isFallbackAdapter: false } };
    expect(softwareAdapterNotice(hardware, query(''))).toBe(false);
    expect(softwareAdapterNotice(hardware, query('?software'))).toBe(false);
    const lavapipe = { info: { isFallbackAdapter: true } };
    // Tools pass `&software`; "Start anyway" writes `software=` into the URL for a reload.
    expect(softwareAdapterNotice(lavapipe, query('?mode=freeflight&seed=1983&dev&software'))).toBe(
      false,
    );
    expect(softwareAdapterNotice(lavapipe, query('?software='))).toBe(false);
  });
});
