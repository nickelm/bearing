// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/** Module paths, matched both as a directory import and as anything inside it. */
const layer = (name) => [`**/${name}`, `**/${name}/**`];

const RENDER_UI = {
  group: [...layer('render'), ...layer('ui')],
  message: 'Simulation, world generation and core code must not depend on render or ui.',
};
const GRAPHICS_PACKAGES = [
  { name: 'three/webgpu', message: 'Headless layers must not depend on the renderer.' },
  { name: 'three/tsl', message: 'Headless layers must not depend on shader code.' },
  { name: 'lil-gui', message: 'Debug UI belongs in src/ui.' },
];
const NO_MATH_RANDOM = [
  'error',
  {
    object: 'Math',
    property: 'random',
    message: 'Non-deterministic. Use rng(worldSeed, "stream-name") from src/core/rng.ts.',
  },
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  // ---- Layering and determinism (see CLAUDE.md, docs/decisions.md) ----
  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: GRAPHICS_PACKAGES,
          patterns: [
            RENDER_UI,
            {
              group: [...layer('sim'), ...layer('worldgen')],
              message: 'src/core is the leaf layer and must not import sim or worldgen.',
            },
          ],
        },
      ],
      'no-restricted-properties': NO_MATH_RANDOM,
    },
  },
  {
    files: ['src/sim/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: GRAPHICS_PACKAGES, patterns: [RENDER_UI] }],
      'no-restricted-properties': NO_MATH_RANDOM,
    },
  },
  {
    // worldgen may use three/webgpu + three/tsl for GPU compute (erosion, baking).
    files: ['src/worldgen/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'lil-gui', message: 'Debug UI belongs in src/ui.' }],
          patterns: [RENDER_UI],
        },
      ],
      'no-restricted-properties': NO_MATH_RANDOM,
    },
  },
  prettier,
);
