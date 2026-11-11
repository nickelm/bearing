import { describe, expect, it } from 'vitest';
import { buildStampText, formatAge } from '../src/ui/buildStamp';

describe('build stamp', () => {
  it('formats the age of a build', () => {
    expect(formatAge(20_000)).toBe('just now');
    expect(formatAge(12 * 60_000)).toBe('12 min ago');
    expect(formatAge(3 * 3_600_000)).toBe('3 h ago');
    expect(formatAge(3 * 86_400_000)).toBe('3 d ago');
  });

  it('names the commit and the build time, or says it is a dev build', () => {
    const built = '2026-11-11T13:24:00Z';
    const text = buildStampText('6274249', built, Date.parse(built) + 5 * 60_000);
    expect(text).toMatch(/^build 6274249 · .+ \(5 min ago\)$/);
    expect(buildStampText('dev', '', 0)).toBe('dev build');
  });
});
