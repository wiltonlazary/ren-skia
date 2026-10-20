# ren-skia

The Skia renderer for [ren-core](https://github.com/wiltonlazary/ren-core): a ren-core `Host`
(`ren-core/host`) over CanvasKit. Its engine is
[ren-canv](https://github.com/wiltonlazary/ren-canv)'s `Document`; this package
measures text with the font file's own advances (ren-canv's `Sfnt`), draws
it with CanvasKit fonts and replays the frames on a CanvasKit
surface (`src/fonts.js`, `src/replay.js`, `src/index.js`). It keeps a retained scene of ren-core's portable
primitives, lays it out, measures text from the font file, paints it into a
flat typed command buffer and replays that on a CanvasKit surface, repainting
only damaged rectangles. It hit-tests and routes press, change, key and
focus itself, and in a document adds a native text entry and an
accessibility mirror beside the canvas. Plain JavaScript with JSDoc types,
strict `tsc` checking and generated declarations.

The package is published on npm as `@maxenve/ren-skia` under the MIT license;
install it under its import name: `npm install ren-skia@npm:@maxenve/ren-skia`.
Its runtime dependencies are ren-canv and ren-core (linked from the
sibling checkouts); `canvaskit-wasm` 0.40.0 is a peer
the caller loads and passes in. The DejaVu Sans font ships in `assets/`
(`ren-skia/font.ttf`, with its license), and DejaVu Sans Mono
(`ren-skia/mono.ttf`): the `mono` option takes a monospace typeface's
bytes, which text whose `fontFamily` names monospace is measured and drawn
in (in `font` without it). Weights draw in the nearest face: the regular,
or its synthesized bold from 600. The `families` option takes typefaces by
family name (text whose `fontFamily` names one is set in it) and
`fallback` a list of typefaces: a character a typeface lacks is measured
and drawn in the first of them that has it (its missing glyph when none
has). Right-to-left text is laid out by ren-canv's bidirectional algorithm.
Text a shaper sets otherwise than by the advances (Arabic joined, lam-alef,
Indic clusters, marks on their bases) is measured as ren-canv shapes it and
drawn as those glyphs at their places (CanvasKit's `drawGlyphs`), a
right-to-left piece from its left edge; other right-to-left runs are drawn
glyph by glyph, reversed and mirrored. It can share a page with ren-dom and
ren-three: each application root has its own renderer.

```jsx
import { Root, $signal, $read, $write, $active, View, Label, Action } from 'ren-core';
import { $dom } from 'ren-dom';
import { $skia, render, attach } from 'ren-skia';

const kit = await CanvasKitInit({ locateFile: file => `/canvaskit/${file}` });
const font = await (await fetch('/font.ttf')).arrayBuffer();

const Counter = () => {
  const count = $signal($active(), 0);
  return (
    <View gap={8} pad={12}>
      <Label text={() => `count ${$read(count)}`} />
      <Action text="+1" onPress={() => $write(count, $read(count) + 1)} />
    </View>
  );
};

// As an application root (in a document, the root makes and attaches the canvas):
Root({ id: 'paint', target: document.body, renderer: $skia(kit, { font, width: 320, height: 200, scale: 2 }), children: <Counter /> });
// Nested in a DOM view: <Root id="chart" renderer={$skia(kit, { font })}>{() => <Counter />}</Root>
// Headless, or on a canvas of your own:
const skia = $skia(kit, { font, width: 320, height: 200 });
const dispose = render(() => <Counter />, skia);
const stop = attach(skia, canvas);
```

| Export | What |
| --- | --- |
| `$skia(kit, options)` | the renderer (a `Renderer`): the Host, input (`press`, `key`, `type`, `select`, `compose`, `commit`, `input`, `wheel`, `tab`), `resize`, `commands()` and `pixel(x, y)` for tests |
| `render(view, renderer, options)` | `mount` into the renderer's page; the dispose presents the empty page |
| `attach(renderer, canvas)` | routes a canvas's pointer, key and wheel events; in a document adds the text entry and the mirror; returns the stop |
| `decode`, `commands`, `operands`, `hex`, `Frame` | the paint command buffer, for tests and tools |
| `Renderer` | the renderer's class (`$skia` makes one) |
| `loadLayout`, `remoteLayout` | the layout engine: load it once; lay out in a worker |
| `loadShaper` | the text shaper (HarfBuzz): in a browser, load it once with the URL of harfbuzzjs's `harfbuzz.wasm` before shaped text renders; node loads it when text first needs it |
| `Press`, `Pointer`, `Change`, `Key`, `Scrolled`, `Item`, `Theme` | the events the primitives receive, the scene item, the theme |

Only the portable primitives render (`View`, `Layout`, `Scroll`, `Label`,
`Edit`, `Action`, `Image`, `Shape`); any other element throws, pointing at
them. The same components render on ren-dom.

## Layout

Layout is ren-canv's engine, Taffy by default: `await loadLayout()` once
before the first renderer, as CanvasKit is loaded (in a browser, with the
URL of taffy-layout's `taffy_wasm_bg.wasm`). Or lay out in a worker: `layout:
remoteLayout(worker)`, with `serveLayout` from `ren-canv/worker` there; the
renderer paints when the boxes come back. Text is measured here, from the
font file's own advances (ren-canv's `Sfnt`), at the size the text is set at
(down to a 64th, as Chrome sets it), which the CanvasKit fonts draw at that
size, slightly hinted as Chrome hints, with linear metrics; text that needs
shaping is measured as its shaped glyphs (ren-canv's `loadShaper`).

Text weighs what Chrome's DOM text weighs. CanvasKit's grayscale glyphs
carry no text contrast or gamma (set in its build; its JavaScript API has
no knob: not font edging, which draws the same on its surfaces, nor
hinting, a Paint setting, or CanvasKit 0.41–0.42): drawn once, black text
inks 0.76–0.83 of the DOM's at 12–20px. Dark text is drawn a second time at alpha
`0.8·(1 − Y/0.3)` (Y the color's linear luminance), which composes to
Skia's own contrast, `a + c·a·(1 − a)` of a glyph's coverage. Measured in
headless Chrome 154 against the DOM, same font, lines and size, ink
(summed luma against the background) as a share of the DOM's, drawn once
against with the second pass at 14px: #000 0.79 against 0.99, #212529 on
#f8f9fa 0.82 against 1.00, #666 0.92 against 1.02, #868e96 0.98 against
0.99, #228be6 0.98 against 1.02 (12, 16 and 20px within 0.99–1.02 too).
Text with Y ≥ 0.3 is drawn once: #adb5bd inks 1.03
and light on dark 1.08–1.12, a little heavier than the DOM, which a second
pass cannot lighten. The pass doubles the text's raster time: a whole
1,000-row frame's replay in node takes 4.9 ms against 2.2–2.5 drawn once
(ABBA, 2 runs an arm), a keystroke's damage 1.09–1.11 against 0.57–0.64 ms.

## Options

| Option | Meaning |
| --- | --- |
| `font` | the bytes of the typeface (CanvasKit has no default font) |
| `mono` | the bytes of a monospace typeface, for text whose family names monospace (the `font` otherwise) |
| `families` | typefaces' bytes by family name: text whose `fontFamily` names one (the first of its list given here, before a generic family) is measured and drawn in it |
| `fallback` | typefaces' bytes, in order: a character a typeface lacks is measured and drawn in the first of them that has it |
| `width`, `height` | the viewport in logical pixels (800 × 600) |
| `scale` | device pixels per logical pixel (1) |
| `theme` | theme color and metric overrides (ren-core's `Theme` tokens) |
| `background` | the ARGB page color (the theme's `canvas`) |
| `layout` | where layout runs: this thread (default), or a layout worker, `remoteLayout(port)` |
| `gpu` | draw a canvas through WebGL (`true`, the default where the browser has it on a GPU; where WebGL is drawn in software, as in headless Chrome, CanvasKit's own raster is used, being faster; damage repaint keeps working, the context preserving its buffer) or CanvasKit's software raster (`false`) |
| `canvas` | a canvas to draw into (browsers); an offscreen surface otherwise. An application root in a document makes one in its host element |
| `image` | loads an `Image` source; `fetch` in browsers by default |
| `aria` | the accessibility mirror `attach` keeps beside the canvas: `true` (default), `false`, or `'demand'` (once a user activates its hidden "Enable accessibility" button) |
| `behavior` | how the page behaves under the user's hands, as ren-canv's: `'app'` (default: loose text not selectable; Ctrl or Cmd+A, the I-beam and the browser's context menu only in an Edit or a `select: 'text'` element; no touch callout), `'page'`, or `{ like, select, selectAll, textCursor, menu, editMenu, callout }` |

`setTheme(tokens)` takes a new theme at once: every primitive resolves again, lays out and repaints; the view, focus, selection and state stay. The background follows the theme's canvas unless `background` was given.

## Text entry, accessibility and repaint

`attach(renderer, canvas)` routes the canvas's pointer, key and wheel events.
In a document it also adds two things beside the canvas.

- **Native text entry** (ren-canv's `src/entry.js`). While an Edit has focus, a
  transparent textarea covers its field and holds the DOM focus. Otherwise
  IME composition, virtual keyboards, dictation, paste and the platform's
  selection could not reach the canvas. The renderer's draft stays the
  value, and the textarea mirrors it:
  - Keys go through `key` as on the canvas. The renderer cancels only the
    keys it acts on; dead keys, shortcuts and a virtual keyboard's keys
    (229) edit the textarea natively.
  - `compositionstart`/`compositionupdate` show the preedit underlined
    (`compose(text)`), and `compositionend` commits it (`commit(text)`) with
    one `change`.
  - `input` hands over the whole value and selection (`input(value, anchor,
    caret)`). `beforeinput` turns a line break into Enter on a one-line
    Edit, and `select`/`selectionchange` mirror the selection
    (`select(anchor, caret)`), which the renderer draws.

  Everything reaches the application as the renderer's own `change`, `key`
  and `submit` events. So worker mode needs nothing of its own, and the
  preedit never crosses the wire. The renderer's own editing also handles
  selections: Shift with an arrow, Home or End extends one, typing replaces
  it, and Backspace and Delete remove it. Surrogate pairs count as one
  character.
- **Accessibility mirror** (ren-canv's `src/aria.js`, the `aria` option). A
  visually hidden DOM tree of the scene: a div per container, a `p` per
  Label, a button per Action (activating it presses the Action), a textbox
  per Edit (focusing it focuses the Edit), and a div with role `img` per
  Image, named by its `alt` (`alt=""` makes it `presentation`, with no
  name, as a decorative DOM img).
  - It is incremental. Structure follows the renderer's `insert` and
    `remove` calls one to one, so a keyed move is one DOM move. A new
    element gets its text while still detached. A later text or state change
    marks its item, and `present` writes only the marked items.
  - The box lies off screen, 1 px and clipped, with no
    `content-visibility`: Chrome leaves the content of an off-screen
    `content-visibility: auto` box out of its accessibility tree, which
    would hide the whole mirror. `npm run browser` in ren-show checks Chrome's
    accessibility tree exposes the Skia gallery's buttons and text fields.
  - `aria: true` (the default) builds the mirror at `attach`. `aria:
    'demand'` adds only a hidden "Enable accessibility" button after the
    canvas, which builds the mirror when activated,
    and `false` never builds it.

**Damage repaint.** `present` repaints only what differs from the last
frame:
- The painter records each drawn piece: a fill, an item's own drawing, or a
  scrollbar, with its box and its range of commands.
- Pieces that moved, changed, appeared or went away give damage rectangles:
  their old and new boxes, merged.
- Each rectangle grows over any piece it cuts. A shape cut by a clip
  rasterizes its antialiased edge a little differently.
- The replay clears and redraws inside the rectangles only, skipping
  commands outside them. CanvasKit then copies only that area to the
  canvas.
- A frame that differs in nothing is not replayed. The first frame, a resize,
  an image load and damage over half the viewport repaint whole.
- `renderer.repaint` tells which happened (`'full'`, `'damage'`, `'none'`).
  A damage frame the image cache draws whole to stay within its bound still
  reports `'damage'`; its pixels are the same.
  `renderer.partial = false` turns damage repaint off.
- Tests check that damage repaint gives the pixels of a full repaint after
  every step, direct and in worker mode.

**WebGL context loss.** A canvas drawn through WebGL listens for the
browser losing its context (a GPU reset, a driver update, too many
contexts). On `webglcontextlost` the renderer prevents the default, so the
browser may restore the context, abandons and frees the surface and
CanvasKit's context, and draws nothing: the scene still changes, lays out
and resizes, and `drawing` is false. On `webglcontextrestored` it makes the
context and surface again at the current size and draws the whole frame.
Typefaces, images, paints and shaders live in CanvasKit's own memory, not
the GPU's, so they stay; their GPU copies (glyph atlases, textures) belong
to the context and are made again as they are drawn. A renderer closed
while its context is lost frees what it holds without throwing, and lets
the context go as soon as the browser restores it.

Measured with 1,000 bench/ui rows (38 high) on an 800×600 canvas, in node
(`bench/skia/frames.jsx --suite damage`, 10 rounds, µs median per frame):
create 5,850, swap 340, scroll 2,250, update every 10th label 590, a
keystroke 670, clear 690.

Headless Chrome 154 ([`bench/skia/chrome.mjs`](https://github.com/wiltonlazary/ren-bench/blob/main/bench/skia/chrome.mjs), 2 Chrome runs per
arm in ABBA order × 10 rounds after 3, load 5.6–6.9, software raster). The
table gives main-thread ms from the operation to the end of present,
CanvasKit's copy included, as min / median. Every row reaches the next
frame in 16.5–16.7 ms median. Damage repaint saves the replay; what is
left is the engine's (ren-canv's layout and draw), which in node is about
1.7 ms of a swap's 2.0:

| operation | full repaint | damage repaint |
| --- | ---: | ---: |
| swap rows 2 and 999 | 3.3 / 6.7 | 2.4 / 5.8 |
| update every 10th label | 5.6 / 7.8 | 4.2 / 7.1 |
| a keystroke | 2.0 / 4.3 | 0.6 / 1.1 |

In node on happy-dom ([`bench/skia/frames.jsx`](https://github.com/wiltonlazary/ren-bench/blob/main/bench/skia/frames.jsx), 10 ABBA rounds, per frame,
median µs, load 3–5):
- Damage repaint against full: swap 290 against 1,742, update 191 against
  1,734, keystroke 504 against 1,718. Scroll, create and clear repaint whole
  in both.
- The incremental mirror against a per-frame walk: swap 662 against 1,359,
  update 577 against 1,696, keystroke 648 against 1,853 µs.

Deliberate choices, measured with [`bench/skia/frames.jsx`](https://github.com/wiltonlazary/ren-bench/blob/main/bench/skia/frames.jsx):

- The painter stops visiting a container's children at the first one below
  the clip, because children are laid out top to bottom. Median painter time
  per frame on 1,000 rows is 2.8 µs on swap against 7.6 visiting every
  child, 4.5 against 26.2 µs on scroll, and 3.1 against 8.4 µs on update
  (sequential runs, load 2).
- The painter records no per-item drawing segments (containers in local
  coordinates, translated at splice time). Measured against it, segments cut
  the commands drawn per frame from 120 to 5 on a swap and from 138 to 5 on
  a scroll, but painter time is 2.4 against 2.8 µs on swap, 4.3 against 4.5
  on scroll and 7.7 against 3.1 µs on update, beside about 1,000 µs of
  CanvasKit replay per frame (20 ABBA rounds).


## Tests

```sh
(cd ../../../rrx-core/wtree/_repo_ && npm install)   # rrx-core, ren-core, ren-canv, then ren-dom: their installs generate the types checked here
(cd ../../../ren-core/wtree/_repo_ && npm install)
(cd ../../../ren-canv/wtree/_repo_ && npm install)
(cd ../../../ren-dom/wtree/_repo_ && npm install)
npm install        # ren-core, rrx-core, ren-canv and ren-dom (linked), pinned devDependencies: canvaskit-wasm, esbuild, happy-dom, typescript
bash -c 'ulimit -v 6000000; NODE_OPTIONS="--max-old-space-size=1024 --disable-wasm-trap-handler" npm test'
```

- `test/skia.test.jsx` (headless CanvasKit, happy-dom for the document
  parts) covers the JSX components on the canvas: command buffers and
  pixels, repaint after a flush and none after an unchanged one, press, key
  and focus routing, editing (multi-line, IME composition, selection), the
  native entry through `attach`, the accessibility mirror (incremental and
  on demand), Tab order, regions, scrolling and wrapping, drawing only what
  is in view, damage repaint with the pixels of a full repaint, portals,
  resize, disposal, and WebGL context loss and restoration (CanvasKit's
  WebGL calls stood in for: node has no WebGL).
- `test/remote-skia.test.jsx` renders the same components direct and in
  worker mode and compares the Skia command buffers (and pixels) after every
  step, with composition, selection and native input.
- `test/roots.test.jsx` runs Skia roots beside ren-dom's `$dom` and `$shadow`
  roots on one document, a Skia root nested in a DOM view with props and
  messages, and disposal that leaves no globals or listeners (ren-dom is a
  devDependency for these).
- `test/paint.test.jsx` checks in pixels paint as CSS draws it: rounded
  clips, per-corner radii, per-side borders and their styles, gradients,
  transforms and an Image's fit.
- `test/place.test.jsx` covers placement and stacking: absolute items
  painted and pressed in z order, a change of order alone repainted by
  damage, `getBoundingClientRect`, and an Action holding content.
- `test/timers.test.js` fails a timer call that does not say why it is one.
- `test/exports.test.js` locks the public contract to
  `test/exports.lock.json`.
- `npm test` runs the `.jsx` suites twice: with the automatic runtime
  (`ren-core/loader`) and compiled by ren-core/esbuild (`ren-core/compiled`).
- `test/types/` holds a TypeScript consumer compiled with `tsc --noEmit`
  (with `skipLibCheck`: canvaskit-wasm's `@webgpu/types` redeclare what
  TypeScript 7's `lib.dom` has).

## Benchmarks

The harnesses live in [ren-bench](https://github.com/wiltonlazary/ren-bench).
Run benchmark commands from that checkout.

[`bench/skia/frames.jsx`](https://github.com/wiltonlazary/ren-bench/blob/main/bench/skia/frames.jsx) (node, no browser) and [`bench/skia/chrome.mjs`](https://github.com/wiltonlazary/ren-bench/blob/main/bench/skia/chrome.mjs)
(headless Chrome) measure the per-frame cost, damage repaint and the
accessibility mirror (the numbers above). The Chrome page loads Taffy
(`loadLayout('/taffy.wasm')`, served from ren-canv's taffy-layout) beside
CanvasKit, and the driver watches it through the DevTools protocol: a page
exception or console error fails the run at once with its message, and a
keystroke that misses the Edit fails it too. [`bench/skia/busy.jsx`](https://github.com/wiltonlazary/ren-bench/blob/main/bench/skia/busy.jsx) measures
a busy screen (two columns of 24 rows on their own backgrounds, a tick and
a hover beside their edge each frame): the columns' fills stay out of the
damage, 4.4% of the canvas, and a frame takes 0.62 ms median at scale 1
against 5.28 ms drawn whole, 1.85 against 20.3 ms at scale 2 (node
v24.15.0, CanvasKit 0.40.0, 400 frames, 4 ABBA runs an arm, load 4.4-5.6).

```sh
cd ../../../ren-bench/wtree/_repo_
node --import ren-core/loader bench/skia/frames.jsx [--suite aria|damage] [--rounds 10] [--warmup 3]
node --import ren-core/loader bench/skia/busy.jsx [--frames 400] [--warmup 50] [--scale 1]
flock "$HOME/.cache/chrome-bench.lock" node bench/skia/chrome.mjs [--suite aria|damage]
```

ren-bench's `bench/ui` (worker mode against direct mode, disposal under input)
runs on this renderer too.
