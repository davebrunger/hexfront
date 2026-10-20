# Hexfront

A turn-based hex wargame for the browser. Graphics are plain **SVG**, code is **TypeScript**, tooling is **Vite**.
You command Blue against a computer-controlled Red on a randomly generated, point-symmetric map.

## Run it

```bash
npm install
npm run dev        # dev server with hot reload
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
npm test           # unit tests + AI-vs-AI simulations
```

Add `?seed=1234` to the URL to replay a specific map.

## Rules in brief

- Win by **wiping out the enemy**, or by having more strength left at the end of turn 30.
- Each unit may **move, then attack once**. Attacking ends its move. Infantry can move 1 space and attack, or 2 without attacking; Armour can move up to 3 and attack; Artillery can attack, or move 1.
- **Attacking** rolls one die per point of attack, which falls off with range. Dice faces are Infantry, Infantry, Armour, Grenade, Flag, Star; each grenade or face matching the target's type does 1 damage. There is no return fire.
- **Terrain:** every hex costs 1 space to enter, entering forest or hills ends your move, and lakes are impassable. Attacks on units in forest or on hills roll one die fewer, except from artillery.
- **Zones of control:** entering a hex next to an enemy ends your move.

Keys: `Esc` cancel · `N` next ready unit · `Space` end turn.

## Code layout

| File | Purpose |
| --- | --- |
| `src/hex.ts` | Axial hex maths, pixel conversion, SVG hexagon points |
| `src/data.ts` | Unit stats, terrain table, game constants — **tune the game here** |
| `src/map.ts` | Seeded, point-symmetric map generator (re-rolls until fully connected) |
| `src/game.ts` | All rules: movement/ZOC, combat, turns, victory. No DOM. |
| `src/ai.ts` | Opponent: scores every reachable hex for each unit. Uses the same rules API as the player. |
| `src/render.ts` | SVG renderer: terrain art, unit counters, highlights, animations |
| `src/main.ts` | Input handling, side panel, turn/AI flow |
| `tests/game.test.ts` | Unit tests and full AI-vs-AI games |

The rules engine is independent of the browser, so adding a second human player, a different AI, or network play means
changing `main.ts`, not the rules.
