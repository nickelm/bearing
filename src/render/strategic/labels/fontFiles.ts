/** Package paths of the label font files (decision 98), for Node, which resolves them in node_modules. */
import type { FontId } from './fontAtlas';

export const LABEL_FONT_FILES: Record<FontId, string> = {
  serifItalic: '@fontsource/eb-garamond/files/eb-garamond-latin-500-italic.woff',
  sans: '@fontsource/fira-sans/files/fira-sans-latin-500-normal.woff',
  sansBold: '@fontsource/fira-sans/files/fira-sans-latin-600-normal.woff',
};
