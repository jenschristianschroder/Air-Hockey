# FACE/OFF — Air Hockey

A complete browser air hockey game for solo play or two people at opposite ends of one device. No accounts, backend, network play, runtime dependencies, or external assets.

## Play

- **Solo:** play against Chill, Quick, or Fierce AI.
- **Face to face:** put a phone or tablet flat between two players. Coral and mint each control one half of a shared rink; the mint score and prompts face the opposite player.
- Drag anywhere in your own half. Two simultaneous fingers are tracked independently. Each gesture stays bound to its original side, and paddles cannot cross the center line.
- Portrait uses the top and bottom ends; landscape rotates the rink so players sit at the left and right ends. Rotating during play pauses the match.
- First to **5, 7, or 11** goals wins. The conceding player receives the next serve. A stationary puck gets a fresh drop after 2.5 seconds.
- **Keyboard:** solo uses arrows or WASD. In two-player mode coral uses WASD and mint uses arrows. Directions follow the screen in both orientations. Space or Escape pauses.
- Pause controls are available to both players. Matches pause when the tab is hidden or loses focus. Sound can be muted; supported browsers offer full screen and keep the screen awake during play.

## Local development

Requires Node.js 20 or later. No package installation is needed.

```sh
npm run dev
```

Open the printed local address, normally `http://localhost:5173`. Serve over HTTP; JavaScript modules will not load reliably by opening the HTML as a local file.

```sh
npm test
npm run build
```

The build copies only the game assets into `dist/`. All URLs are relative, so repository-path hosting works.

## GitHub Pages

The included `.github/workflows/pages.yml` runs the tests, builds the static assets, and deploys `dist/` when `main` changes. In repository **Settings → Pages**, use **GitHub Actions** as the source. Pull requests run tests and build without deploying.

Expected project address: `https://jenschristianschroder.github.io/Air-Hockey/`.

## Structure and verification

- `physics.js`: deterministic fixed-step simulation at 240 Hz, bounded paddle movement, momentum transfer, wall/post collision, scoring, AI, and touch ownership.
- `game.js`: canvas rendering, audio, pointer and keyboard controls, responsive table layout, and match lifecycle.
- `styles.css` / `index.html`: responsive arcade clubhouse and opposing player HUDs.
- `tests/physics.test.js`: collision, scoring, high-speed shots, fixed-step consistency, touch ownership, rotation mapping, AI, and match lifecycle tests.

Settings are saved locally when browser storage is available. The game still works if storage, audio, full screen, or wake lock is unavailable. This release does not include a service worker or promise offline installation. On iOS, add the game to the Home Screen for more screen space.

Real-device two-finger testing on iOS and Android is recommended in addition to automated simulation and browser checks, particularly for operating-system gestures near screen edges.
