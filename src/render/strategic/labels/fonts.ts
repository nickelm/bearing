/**
 * The label fonts (visual-style Part II, Labels; decision 98), bundled from npm
 * under the SIL Open Font License: EB Garamond italic for water, Fira Sans for
 * landforms, settlements and theaters. Vite turns the `?url` imports into
 * base-relative asset URLs (rule 8); Node previews read the same files from
 * `node_modules` by the paths in `LABEL_FONT_FILES` (fontFiles.ts).
 */
import serifItalicUrl from '@fontsource/eb-garamond/files/eb-garamond-latin-500-italic.woff?url';
import sansUrl from '@fontsource/fira-sans/files/fira-sans-latin-500-normal.woff?url';
import sansBoldUrl from '@fontsource/fira-sans/files/fira-sans-latin-600-normal.woff?url';
import type { FontId } from './fontAtlas';
export { LABEL_FONT_FILES } from './fontFiles';

/** Fetches the three label fonts in the browser. */
export async function fetchLabelFonts(): Promise<Record<FontId, ArrayBuffer>> {
  const get = async (url: string) => (await fetch(url)).arrayBuffer();
  const [serifItalic, sans, sansBold] = await Promise.all([
    get(serifItalicUrl),
    get(sansUrl),
    get(sansBoldUrl),
  ]);
  return { serifItalic, sans, sansBold };
}
