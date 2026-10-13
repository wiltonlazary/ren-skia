// Skia roots beside DOM roots on one document: each confined by its id, with
// its own renderer and theme, a Skia root nested in a DOM view, and nothing
// left behind. happy-dom and a headless CanvasKit.

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window as HappyWindow } from 'happy-dom';
import {
  Root, $roots, $signal, $read, $write, $effect, $dispose, $context, $lookup, $update, $entries, $task,
  Id, Storage, Locks, Runtime, Props, Send, $name,
  Show, For, Portal, Pending, Label, Action, View, $active,
} from 'ren-core';
import { $dom, $shadow } from 'ren-dom';
import { $skia, loadLayout } from 'ren-skia';
import { setFlagsFromString } from 'node:v8';

/** The happy-dom windows this file's tests open, each closed after its test (its window.close() frees nothing). @type {HappyWindow[]} */
const windows = [];
/** happy-dom's Window, tracked for closing. */
class Window extends HappyWindow {
  /** @param {ConstructorParameters<typeof HappyWindow>} args */
  constructor(...args) {
    super(...args);
    windows.push(this);
  }
}
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

/** The layout engine (Taffy's WebAssembly), once, before any renderer. */
// Each WebAssembly memory reserves its whole range up front: 1 GB each (Taffy's, CanvasKit's) keeps
// the process under the address cap the tests run with (.ai/config/resources.md, from the rui root).
setFlagsFromString('--wasm-max-mem-pages=16384');
await loadLayout();

const font = readFileSync(new URL('../assets/font.ttf', import.meta.url));
/** @type {any} */
let kit;
before(async () => {
  const CanvasKitInit = (await import('canvaskit-wasm')).default;
  kit = await CanvasKitInit();
});

const setup = () => {
  const window = new Window();
  const document = window.document;
  const page = document.createElement('main');
  document.body.appendChild(page);
  return { window, document, page };
};

/** A lock manager that records requests. */
const manager = () => {
  /** @type {string[]} */
  const names = [];
  return {
    names,
    /** @param {string} name @param {any} _options @param {(lock: any) => any} callback */
    request: async (name, _options, callback) => {
      names.push(name);
      return callback({ name });
    },
    query: async () => ({ held: names.map(name => ({ name })), pending: [] }),
  };
};

describe('ren-skia roots', () => {
  it('shows a canvas it made at its size as it resizes', () => {
    const window = new Window();
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const skia = /** @type {any} */ ($skia(kit, { font, width: 943, height: 60 }));
    const made = skia.canvasFor(host);
    assert.equal(made.style.width, '943px');
    skia.resize(958, 80);
    assert.deepEqual([made.style.width, made.style.height], ['958px', '80px'], 'not its first size, which would stretch its pixels');
    skia.close();
  });

  it('confines roots with different renderers and themes on one document', () => {
    const { document, page } = setup();
    /** @type {any} */
    const seen = {};
    const Probe = () => {
      seen[$lookup(Id)] = { runtime: $lookup(Runtime).renderer, name: $name('field') };
      return <Label text={$lookup(Id)} />;
    };
    const main = Root({ id: 'main', target: page, renderer: $dom(document, { theme: { accent: 0xff112233 } }), children: <Probe /> });
    const side = Root({ id: 'side', target: page, renderer: $shadow({ theme: { accent: 0xff445566 } }), children: () => <Probe /> });
    const skia = $skia(kit, { font, width: 120, height: 80, theme: { canvas: 0xff000000 } });
    const draw = Root({ id: 'draw', target: page, renderer: skia, children: <Probe /> });
    assert.deepEqual($roots(document).sort(), ['draw', 'main', 'side']);
    assert.deepEqual(seen, {
      main: { runtime: 'dom', name: 'main-field' },
      side: { runtime: 'shadow', name: 'side-field' },
      draw: { runtime: 'skia', name: 'draw-field' },
    });
    const [a, b, c] = page.children;
    assert.equal(a.getAttribute('data-ren-root'), 'main');
    assert.equal(b.getAttribute('data-ren-root'), 'side');
    assert.equal(c.getAttribute('data-ren-root'), 'draw');
    // Theme tokens live on each host, never on the document.
    assert.equal(a.style.getPropertyValue('--ren-accent'), 'rgba(17, 34, 51, 1)');
    assert.equal(b.style.getPropertyValue('--ren-accent'), 'rgba(68, 85, 102, 1)');
    assert.equal(document.documentElement.getAttribute('style'), null);
    assert.equal(document.head.children.length, 0);
    // The light-DOM root carries a scoped <style>; the shadow root adopts its sheet.
    assert.equal(a.firstChild.tagName, 'STYLE');
    assert.match(a.firstChild.textContent, /\[data-ren-root="main"\] \[data-ren="Action"\]:not\(\[data-ren-root="main"\] \[data-ren-root\] \*\)/);
    assert.equal(a.textContent.endsWith('main'), true);
    assert.equal(b.shadowRoot.adoptedStyleSheets.length, 1);
    assert.equal(b.shadowRoot.textContent, 'side');
    assert.equal(b.children.length, 0);
    // The Skia root drew its own theme into its own scene; its canvas sits in its host.
    assert.equal(c.firstChild.tagName, 'CANVAS');
    assert.deepEqual(skia.commands().filter(x => x[0] === 'text').map(x => x[1]), ['draw']);
    assert.equal(skia.pixel(2, 2), 0xff000000);
    $dispose(main);
    $dispose(side);
    $dispose(draw);
    assert.equal(page.children.length, 0);
    assert.deepEqual($roots(document), []);
    assert.equal(skia.closed, true);
  });

  it('nests a root with another renderer, isolated, with props in and messages out', () => {
    const { document, page } = setup();
    const Theme = $context('none');
    /** @type {any} */
    let count = null;
    /** @type {any[]} */
    const messages = [];
    /** @type {any} */
    const inside = {};
    const Child = () => {
      inside.id = $lookup(Id);
      inside.theme = $lookup(Theme);
      inside.storage = $lookup(Storage);
      return (
        <View>
          <Label text={() => `child ${$lookup(Props)}`} />
          <Action text="send" onPress={() => $lookup(Send)({ from: $lookup(Id) })} />
        </View>
      );
    };
    const skia = $skia(kit, { font, width: 100, height: 60 });
    const parent = Root({
      id: 'parent',
      target: page, renderer: $dom(page.ownerDocument),
      storage: null,
      children: () => (
        (count = $signal($active(), 1)),
        <Theme value="parent-theme">
          <Label text="before" />
          <Root id="kid" renderer={$shadow({ theme: { ink: 0xff010203 } })} props={() => $read(count)} onMessage={data => messages.push([$lookup(Theme), data])}>
            {() => <Child />}
          </Root>
          <Label text="after" />
          <Root id="paint" renderer={skia} storage={null}>
            <Label text="painted" />
          </Root>
        </Theme>
      ),
    });
    const host = page.firstChild;
    const kid = host.querySelector('[data-ren-root="kid"]');
    // The parent kept building with its own renderer after the nested root.
    assert.deepEqual([...host.querySelectorAll('[data-ren="Label"]')].map(n => n.textContent), ['before', 'after']);
    assert.equal(kid.shadowRoot.querySelector('[data-ren="Label"]').textContent, 'child 1');
    assert.equal(kid.style.getPropertyValue('--ren-ink'), 'rgba(1, 2, 3, 1)');
    assert.equal(host.style.getPropertyValue('--ren-ink'), 'rgba(38, 62, 52, 1)');
    // Nothing of the parent's context crosses: not its providers, not its storage.
    assert.deepEqual({ ...inside, storage: inside.storage === null ? null : 'shelf' }, { id: 'kid', theme: 'none', storage: 'shelf' });
    $write(count, 2);
    assert.equal(kid.shadowRoot.querySelector('[data-ren="Label"]').textContent, 'child 2');
    kid.shadowRoot.querySelector('[data-ren="Action"]').click();
    assert.deepEqual(messages, [['parent-theme', { from: 'kid' }]]);
    assert.deepEqual(skia.commands().filter(x => x[0] === 'text').map(x => x[1]), ['painted']);
    assert.deepEqual($roots(document).sort(), ['kid', 'paint', 'parent']);
    $dispose(parent);
    assert.deepEqual($roots(document), []);
    assert.equal(kid.shadowRoot.childNodes.length, 0);
    assert.equal(kid.shadowRoot.adoptedStyleSheets.length, 0);
    assert.equal(skia.closed, true);
    assert.equal(page.children.length, 0);
    void document;
  });

  it('leaves no globals and no window listeners behind', () => {
    const { window, document, page } = setup();
    const keys = Object.keys(globalThis).sort();
    /** @type {Map<string, number>} */
    const listening = new Map();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    /** @type {any} */ (window).addEventListener = (/** @type {string} */ name, /** @type {any} */ fn, /** @type {any} */ options) => {
      listening.set(name, (listening.get(name) ?? 0) + 1);
      add(name, fn, options);
    };
    /** @type {any} */ (window).removeEventListener = (/** @type {string} */ name, /** @type {any} */ fn) => {
      listening.set(name, (listening.get(name) ?? 0) - 1);
      remove(name, fn);
    };
    const roots = [
      Root({ id: 'one', target: page, renderer: $dom(page.ownerDocument), children: <Label text="1" /> }),
      Root({ id: 'two', target: page, renderer: $shadow({ mode: 'closed' }), children: <Label text="2" /> }),
      Root({ id: 'three', target: page, renderer: $skia(kit, { font, width: 50, height: 50 }), children: <Label text="3" /> }),
    ];
    assert.equal(listening.get('storage'), 3);
    for (const root of roots) $dispose(root);
    assert.equal(listening.get('storage'), 0);
    assert.deepEqual(Object.keys(globalThis).sort(), keys);
    assert.equal(page.childNodes.length, 0);
    assert.equal(document.head.childNodes.length, 0);
    assert.deepEqual($roots(document), []);
  });
});

