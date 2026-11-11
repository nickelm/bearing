# Style references (local only)

This folder holds the reference board for [docs/visual-style.md](../../visual-style.md): five screenshots supplied by the owner on 2026-11-10. They come from another project, so they are **not in git**. The repository is public, and `.gitignore` keeps everything here except this README out of it (decision 70). The images live in the owner's Dropbox copy of the repository and sync from there.

| File                      | Shows                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| `aircombat-legends-1.jpg` | Carrier at sunset: deck silhouette, deck lights, sun column on the water |
| `aircombat-legends-2.jpg` | Fighter over a river valley: forests, rivers, farmland, a town, haze     |
| `aircombat-legends-3.jpg` | Hangar apron in the desert: faceted mountains, camouflage, crew figures  |
| `aircombat-legends-4.jpg` | Aerial refueling above a soft cloud layer                                |
| `aircombat-legends-5.jpg` | Woodland airbase at dusk: conifers, base buildings, UI panel, letterbox  |

Rules:

- Never commit these images, import them from `src/`, or copy them into `public/` or `dist/`. The Vite config refuses to load anything under `docs/`.
- Use them only to compare against: when a visual milestone closes, compare the acceptance-check views from the style guide with this board.
- If the folder is empty (a fresh clone), ask the owner for the files.
