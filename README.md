# Hexfront

A turn-based hex wargame for the browser. Graphics are plain **SVG**, code is **TypeScript**, tooling is **Vite**.
Command the Allied or Axis side against a computer opponent, on a randomly generated, point-symmetric map or a preset one. The Allies start at the bottom of the map and move first.

## Run it

```bash
npm install
npm run dev        # dev server with hot reload
npm run build      # type-check + build a single self-contained dist/index.html
npm run preview    # serve the production build
npm test           # unit tests + AI-vs-AI simulations
```

Choose your side under **Play as** before pressing **New game**. Add `?seed=1234` to the URL to replay a specific map.

### Preset maps

Pick a map from the **Map** list before pressing **New game**, or leave it on *Random map*. Preset maps live in [`src/config/maps.json`](src/config/maps.json). Each has an `id` (used in the URL as `?map=`), a `name`, and 9 `rows` of terrain letters separated by spaces, top row first. Rows alternate 13 and 12 hexes; start the 12-hex rows with a space so they line up.

| Letter | Terrain |
|---|---|
| `.` | Open ground |
| `f` | Forest |
| `h` | Hills |
| `v` | Village |
| `l` | Lake |
| `r` | River |
| `b` | Bridge |

Add an optional `units` list, laid out the same way, to set the starting positions (`.` for an empty hex). Without it both armies use the standard starting positions. Units can't start on lakes or rivers.

| Letter | Unit |
|---|---|
| `i` / `j` | Allied / Axis infantry |
| `a` / `b` | Allied / Axis armour |
| `r` / `s` | Allied / Axis artillery |

An optional `obstacles` list, laid out the same way, adds man-made obstacles (`.` for none).

| Letter | Obstacle |
|---|---|
| `w` | Barbed wire |
| `0`–`5` | Sandbags along the two edges either side of a corner: `0` is the top corner, counting clockwise (`3` covers the bottom two edges) |

## Rules in brief

- Win by **wiping out the enemy**, or by having more strength left at the end of turn 30.
- Each unit may **move, then attack once**. Attacking ends its move. Infantry can move 1 space and attack, or 2 without attacking; Armour can move up to 3 and attack; Artillery can attack, or move 1.
- **Attacking** rolls one die per point of attack, which falls off with range. Dice faces are Infantry, Infantry, Armour, Grenade, Flag, Star; each grenade or face matching the target's type does 1 damage. There is no return fire.
- **Terrain:** every hex costs 1 space to enter; lakes and rivers are impassable, and bridges can only be entered from land. Entering forest or a village ends your move, and you can't attack on the turn you moved in. Attacks on a unit in forest or a village lose 1 die for infantry and 2 for armour; attacks on a unit on a hill lose 1 die unless the attacker is on a hill too. Armour attacking from a village loses 2 dice. Artillery never loses dice to terrain, and penalties add together. An attack left with no dice can't be made.
- **Obstacles:** **Sandbags** protect a unit on all sides: infantry and armour attacking it lose 1 die (artillery doesn't), though this doesn't add to terrain cover, the larger applies. They are removed from any hex a unit leaves. **Barbed wire** stops a unit entering it. Armour clears it on entering and can still attack; infantry on wire lose 1 attack die, and can clear it instead of attacking.
- **Line of sight:** every unit except artillery needs a clear line from its hex centre to the target's. Units, forest, villages, hills and the half hexes at the side edges block it, and so do two adjacent lake hexes. Between two units on hills, only units on hills block it. The attacker's and target's own hexes never block, and a line running along hex edges is only blocked if both sides are obstructed.
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

## License

[MIT](LICENSE)
