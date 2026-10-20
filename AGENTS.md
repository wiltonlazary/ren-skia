# ren-skia

Standing rules for agents working in this checkout.

Read the workspace layer first: [`../../../AGENTS.md`](https://github.com/wiltonlazary/rui/blob/main/AGENTS.md) and [`../../../.ai/config/`](https://github.com/wiltonlazary/rui/tree/main/.ai/config)
(stability.md first, then javascript.md, design.md, benchmarks.md, concepts.md,
resources.md, git.md).
Then read [README.md](README.md), ren-core's README for the component layer and
the Host contract ([`../../../ren-core/wtree/_repo_/README.md`](https://github.com/wiltonlazary/ren-core)), and
[TODO.md](TODO.md) for open work.

## What this is

ren-skia is ren-core's CanvasKit renderer, a production library packaged as
`ren-skia`: the retained scene, layout, text, painting, damage
repaint, input routing, the native text entry and the accessibility mirror.
The engine (scene, layout, text, paint, damage,
input, entry, mirror) is ren-canv's `Document`; this package holds the
CanvasKit fonts, replay and surface. Its runtime dependencies are ren-canv
and ren-core, linked from the sibling checkouts; `canvaskit-wasm` is a peer the caller passes in.
ren-dom is a devDependency, for the tests of Skia roots beside DOM roots.

## Layout and outputs

- Checkout: `wtree/_repo_` (branch `main`); feature branches are sibling
  worktrees under `wtree/<name>`, each with its own build directory
  `build/<name>_<version>` and its own `artifact` link to it.
- Build output: `build/_repo__0.1.10`, reached through the ignored `artifact`
  link: generated output and scratch (`artifact/tmp/<task>/`).
- Benchmarks belong to [ren-bench](https://github.com/wiltonlazary/ren-bench);
  their bundles, profiles and results are generated there.
- `types/` is generated (`scripts/types.mjs`) and ignored.

## Project specifics

- ren-skia consumes ren-core's public entries only (`ren-core`, `ren-core/host`, and in
  tests `ren-core/worker`, `ren-core/remote`). When it needs something new from ren-core,
  change ren-core first, with ren-core's tests, then this package; both suites must
  pass.
- Install rrx-core, ren-core, ren-canv and ren-dom first: `tsc` reads their
  generated declarations.
- Run node with `--disable-wasm-trap-handler` under the address cap
  (resources.md): CanvasKit's wasm does not start without it.
- Only the portable primitives render here; keep them the same on ren-dom
  (ren-show renders one Gallery on both).
