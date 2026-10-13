// ren-skia: the Skia renderer for ren-core. The engine is ren-canv's Document
// (the retained scene, layout, text, painting into a flat command buffer,
// damage, hit testing, input, editing, the native text entry and the
// accessibility mirror); this package measures text with CanvasKit fonts and
// replays the frames on a CanvasKit surface, repainting only damaged
// rectangles.
//
// CanvasKit is injected: `$skia(await CanvasKitInit(), { font })`.

import { Document } from 'ren-canv';
import { Fonts } from './fonts.js';
import { Replay } from './replay.js';

export { Press, Pointer, Change, Key, Scrolled, Item, Theme, Frame, decode, commands, operands, hex, render, attach, loadLayout, loadShaper, remoteLayout } from 'ren-canv';

/** @typedef {import('canvaskit-wasm').CanvasKit} Kit */
/** @typedef {import('canvaskit-wasm').Surface} Surface */
/** @typedef {import('./replay.js').Loader} Loader */

/**
 * @typedef {object} SkiaOptions
 * @property {ArrayBuffer | Uint8Array} font The bytes of the typeface (CanvasKit has no default font).
 * @property {(ArrayBuffer | Uint8Array)=} mono The bytes of a monospace typeface: text whose `fontFamily` names monospace is measured and drawn in it (in `font` without it).
 * @property {Record<string, ArrayBuffer | Uint8Array>=} families Typefaces by family name: text whose `fontFamily` names one (the first of its list given here, before a generic family) is measured and drawn in it.
 * @property {(ArrayBuffer | Uint8Array)[]=} fallback Typefaces for the characters a typeface lacks: each such character is measured and drawn in the first of them that has it.
 * @property {(HTMLCanvasElement | OffscreenCanvas)=} canvas A canvas to draw into (browsers); an offscreen surface otherwise.
 * @property {Loader=} image Loads an Image source; `fetch` in browsers by default.
 * @property {boolean=} gpu Draw a canvas through WebGL (true, where the browser has it on a GPU) or CanvasKit's software raster (false). The GPU keeps the frame between presents, so damage repaint draws only what changed.
 */

/** @typedef {import('ren-canv').Options & SkiaOptions} Options */

/** @type {Loader} */
const fetchImage = source =>
  fetch(source).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  });

/** Whether a document's canvases draw at all, asked once per document. @type {WeakMap<object, boolean>} */
const drawing = new WeakMap();

/**
 * Whether a document's canvases draw at all, asked of a canvas of its own (a
 * context taken on the renderer's canvas would fix its kind: a 2D canvas
 * takes no WebGL). The probe's WebGL context is lost at once: a page that
 * makes many roots would otherwise run out of contexts.
 * @param {any} doc
 */
function draws(doc) {
  let can = drawing.get(doc);
  if (can !== undefined) return can;
  const probe = doc.createElement('canvas');
  can = false;
  if (typeof probe.getContext === 'function') {
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
    if (gl != null) {
      can = true;
      gl.getExtension?.('WEBGL_lose_context')?.loseContext();
    } else can = probe.getContext('2d') != null;
  }
  drawing.set(doc, can);
  return can;
}

/** Whether a page's WebGL is drawn in software, by its document (the page itself for an OffscreenCanvas). @type {WeakMap<object, boolean>} */
const probed = new WeakMap();
/** WebGL renderers that draw on the CPU. */
const SOFTWARE = /SwiftShader|llvmpipe|softpipe|Software/i;

/**
 * Whether the browser draws WebGL in software (no GPU: headless, a
 * blocklisted driver, many VMs). There CanvasKit's own raster is faster, and
 * WebGL's read back at each commit holds the frame. Probed once per page on a
 * canvas of its own, since a canvas that had WebGL cannot take a 2D context.
 * @param {any} canvas
 * @returns {boolean}
 */
function softwareGL(canvas) {
  const page = canvas.ownerDocument ?? globalThis;
  let software = probed.get(page);
  if (software !== undefined) return software;
  software = false;
  try {
    const probe = canvas.ownerDocument != null ? canvas.ownerDocument.createElement('canvas') : new OffscreenCanvas(1, 1);
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
    if (gl != null) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      software = SOFTWARE.test(String(gl.getParameter(info != null ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // No probe: take WebGL as it comes.
  }
  probed.set(page, software);
  return software;
}

/**
 * The CanvasKit renderer: a ren-canv Document (the ren-core Host, plus the input
 * methods a host environment drives) drawn on a CanvasKit surface.
 */
export class Renderer extends Document {
  /** @param {Kit} kit @param {Options} options */
  constructor(kit, options) {
    if (options == null || options.font == null) throw new Error('REN skia: options.font must hold the typeface bytes');
    const fonts = new Fonts(kit, options.font, options.mono ?? null, options.families ?? {}, options.fallback ?? []);
    super(fonts, options);
    this.kit = kit;
    /** @type {Fonts} */
    this.fonts = fonts;
    this.replay = new Replay(
      kit,
      fonts,
      options.image ?? (typeof fetch === 'function' ? fetchImage : null),
      () => {
        // A loaded image changes pixels, not commands.
        this.damage = true;
        this.full = true;
        this.present();
      },
      source => this.failed(source),
      source => this.forgot(source),
    );
    /** @type {HTMLCanvasElement | OffscreenCanvas | null} */
    this.canvas = options.canvas ?? null;
    /** @type {Surface | null} */
    this.surface = null;
    /** Draw through WebGL where there is a canvas and a context. */
    this.gpu = options.gpu !== false;
    /** The WebGL context the GPU surfaces draw into, made once per canvas (CanvasKit makes it current for each call). @type {any} */
    this.gl = null;
    /** The browser's WebGL context under it. @type {any} */
    this.context = null;
    /** CanvasKit's handle of that context, deleted with it. */
    this.handle = 0;
    /** True from the browser losing the WebGL context until it restores it: nothing draws meanwhile. */
    this.blank = false;
    /** Removes the listeners of the context's loss and restoration. @type {(() => void) | null} */
    this.unwatch = null;
    this.grow();
  }

  /** The renderer's name, for `Runtime`. */
  get kind() {
    return 'skia';
  }

  get drawing() {
    return this.surface !== null;
  }

  /** @param {import('ren-canv/backend').Frame} frame @param {import('ren-canv/backend').Damage | null} damage */
  draw(frame, damage) {
    const surface = /** @type {Surface} */ (this.surface);
    this.replay.run(surface.getCanvas(), frame, this.scale, this.background, damage, this.shiftX, this.shiftY);
    if (damage === null || this.gpu) surface.flush();
    else {
      const s = this.scale;
      const x = this.shiftX;
      const y = this.shiftY;
      // CanvasKit copies only this rectangle of a canvas surface to its canvas: the damage where the shift drew it.
      /** @type {any} */ (surface).flush([Math.floor((damage.left + x) * s), Math.floor((damage.top + y) * s), Math.ceil((damage.right + x) * s), Math.ceil((damage.bottom + y) * s)]);
    }
  }

  /**
   * An application root's canvas: the `canvas` option's, or a new one in
   * its host element. Where it has no 2D context (headless), the surface
   * stays offscreen.
   * @param {any} element
   */
  canvasFor(element) {
    if (this.canvas !== null) return this.canvas;
    const made = element.ownerDocument.createElement('canvas');
    made.style.width = `${this.width}px`;
    made.style.height = `${this.height}px`;
    element.appendChild(made);
    this.made = made;
    if (draws(element.ownerDocument)) {
      this.canvas = made;
      this.grow();
    }
    return made;
  }

  /** The ARGB color of the surface at a logical point. @param {number} x @param {number} y */
  pixel(x, y) {
    const kit = this.kit;
    const surface = this.surface;
    if (surface === null) return 0;
    const p = surface.getCanvas().readPixels(Math.floor(x * this.scale), Math.floor(y * this.scale), {
      width: 1,
      height: 1,
      colorType: kit.ColorType.RGBA_8888,
      alphaType: kit.AlphaType.Unpremul,
      colorSpace: kit.ColorSpace.SRGB,
    });
    if (p == null) return 0;
    return ((p[3] << 24) | (p[0] << 16) | (p[1] << 8) | p[2]) >>> 0;
  }

  /** Makes the surface for the current size. */
  grow() {
    // dispose, not delete: a raster surface's pixels are CanvasKit memory of their own, which delete() leaves behind.
    if (this.surface !== null) this.surface.dispose();
    this.surface = null;
    this.full = true;
    const w = Math.max(1, Math.round(this.width * this.scale));
    const h = Math.max(1, Math.round(this.height * this.scale));
    const canvas = this.canvas;
    const kit = this.kit;
    if (canvas !== null) {
      canvas.width = w;
      canvas.height = h;
      // A lost WebGL context has nothing to draw on: the surface is made at this size when it is restored.
      if (this.blank) return;
      this.surface = this.gpu ? this.onGPU(canvas, w, h) : null;
      if (this.surface === null) {
        this.gpu = false;
        this.surface = kit.MakeSWCanvasSurface(/** @type {any} */ (canvas));
      }
    } else this.surface = kit.MakeSurface(w, h);
    if (this.surface === null) throw new Error('REN skia: CanvasKit could not make a surface');
  }

  /**
   * A WebGL surface on the canvas, or null where WebGL is missing. The
   * context keeps its drawing buffer between presents (damage repaint draws
   * over the last frame) and is made once, again after the browser restores
   * it; a new size makes a new surface on it.
   * @param {any} canvas @param {number} w @param {number} h
   * @returns {Surface | null}
   */
  onGPU(canvas, w, h) {
    const kit = /** @type {any} */ (this.kit);
    if (typeof kit.GetWebGLContext !== 'function' || typeof canvas.getContext !== 'function') return null;
    try {
      if (this.gl === null && softwareGL(canvas)) return null;
      if (this.gl === null) {
        const handle = kit.GetWebGLContext(canvas, { preserveDrawingBuffer: 1, antialias: 0, depth: 0, stencil: 0, alpha: 1, premultipliedAlpha: 1 });
        if (!handle) return null;
        this.handle = handle;
        // The browser's context CanvasKit made on the canvas (the same object getContext returns), lost on close.
        this.context = canvas.getContext('webgl2') ?? canvas.getContext('webgl') ?? null;
        this.gl = kit.MakeWebGLContext(handle);
        if (this.gl === null) return null;
        if (this.unwatch === null && typeof canvas.addEventListener === 'function') {
          /** @param {Event} event */
          const lost = event => this.contextLost(event);
          const restored = () => this.contextRestored();
          canvas.addEventListener('webglcontextlost', lost);
          canvas.addEventListener('webglcontextrestored', restored);
          this.unwatch = () => {
            canvas.removeEventListener('webglcontextlost', lost);
            canvas.removeEventListener('webglcontextrestored', restored);
          };
        }
      }
      return kit.MakeOnScreenGLSurface(this.gl, w, h, kit.ColorSpace.SRGB);
    } catch {
      return null;
    }
  }

  /**
   * The browser lost the canvas's WebGL context (a GPU reset, a driver
   * update, too many contexts): drawing stops until it restores it, which
   * it does only for a context whose loss was prevented.
   * @param {Event} event
   */
  contextLost(event) {
    event.preventDefault();
    if (this.closed || this.blank) return;
    this.blank = true;
    this.freeGL(true);
  }

  /**
   * The browser restored the canvas's WebGL context: the context and
   * surface are made again, and the whole frame is drawn on them. Typefaces,
   * images, paints and shaders are CanvasKit objects in its own memory, not
   * the GPU's; their GPU copies (glyph atlases, textures) belong to the
   * context and are made again from them as they are drawn. On a renderer
   * closed while the context was lost, the context is let go at once.
   */
  contextRestored() {
    if (!this.blank) return;
    this.blank = false;
    if (this.closed) {
      this.unwatch?.();
      this.unwatch = null;
      this.context?.getExtension?.('WEBGL_lose_context')?.loseContext();
      this.context = null;
      return;
    }
    try {
      this.grow();
    } catch {
      // No surface on the restored context: nothing draws, as on a lost one.
      this.surface = null;
    }
    this.damage = true;
    this.present();
  }

  /**
   * Frees the surface and CanvasKit's WebGL context; `abandon` when the
   * browser's context is gone, so Skia frees its GPU objects without
   * calling into it.
   * @param {boolean} abandon
   */
  freeGL(abandon) {
    const gl = this.gl;
    if (abandon && gl !== null) gl.releaseResourcesAndAbandonContext();
    if (this.surface !== null) this.surface.dispose();
    this.surface = null;
    if (gl !== null) gl.delete();
    this.gl = null;
    const kit = /** @type {any} */ (this.kit);
    if (this.handle !== 0 && typeof kit.deleteContext === 'function') kit.deleteContext(this.handle);
    this.handle = 0;
  }

  sized() {
    // A canvas it made is shown at the size it draws: its pixels would be stretched to its old size.
    const made = this.made;
    if (made != null) {
      made.style.width = `${this.width}px`;
      made.style.height = `${this.height}px`;
    }
    this.grow();
  }

  /**
   * Frees the surface, fonts and paints. The scene stays until its view is
   * disposed; for an application root (after `open`), the page and overlay
   * are emptied, input stops and the canvas `open` made is removed.
   */
  close() {
    if (this.closed) return;
    super.close();
    const made = this.made;
    if (made !== null && made.parentNode != null) made.parentNode.removeChild(made);
    this.made = null;
    this.freeGL(false);
    this.replay.close();
    // A lost context is let go when the browser restores it (contextRestored).
    if (this.blank) return;
    this.unwatch?.();
    this.unwatch = null;
    // Deleting CanvasKit's context keeps the browser's until the canvas is
    // collected: a page that remakes roots would run out of contexts (the
    // browser drops the oldest). Lose it at once.
    this.context?.getExtension?.('WEBGL_lose_context')?.loseContext();
    this.context = null;
  }
}

/**
 * A CanvasKit renderer: the Host for `mount`, plus input and drawing.
 * @param {Kit} kit an initialized CanvasKit
 * @param {Options} options
 */
export function $skia(kit, options) {
  return new Renderer(kit, options);
}
