// The CanvasKit executor: replays a frame's flat command buffer on a canvas
// (the drawing contract of draw.js's command vocabulary). Paints and
// rectangles are reused, so a replay allocates only what
// CanvasKit itself does for text and paths.

import { TEXT_OP, RECT, ROUND, CLIP, SAVE, RESTORE, LINE, OVAL, PATH, IMAGE_OP, BORDER, SHADOW, LAYER, RTL, commands, operands, reversed } from 'ren-canv/backend';

// Opcodes the backend entry names by `commands` only.
const RCLIP = commands.indexOf('rclip');
const RROUND = commands.indexOf('rround');
const RBORDER = commands.indexOf('rborder');
const RSHADOW = commands.indexOf('rshadow');
const DASH = commands.indexOf('dash');
const EDGES = commands.indexOf('edges');
const GRADIENT = commands.indexOf('gradient');
const TRANSFORM = commands.indexOf('transform');
const PICTURE = commands.indexOf('picture');
const SHADE = commands.indexOf('shade');

/**
 * Where an image of `w` × `h` goes in a box, as CSS's object-fit (ren-canv's
 * picture command): 1 contain, 2 cover, 3 none, centered; else the box.
 * @param {number} w @param {number} h @param {number} x @param {number} y @param {number} right @param {number} bottom @param {number} fit
 * @returns {[number, number, number, number]}
 */
function fitted(w, h, x, y, right, bottom, fit) {
  const bw = right - x;
  const bh = bottom - y;
  if (!(w > 0 && h > 0) || fit < 1 || fit > 3) return [x, y, right, bottom];
  const k = fit === 1 ? Math.min(bw / w, bh / h) : fit === 2 ? Math.max(bw / w, bh / h) : 1;
  const left = x + (bw - w * k) / 2;
  const top = y + (bh - h * k) / 2;
  return [left, top, left + w * k, top + h * k];
}

/**
 * Where a gradient runs in a box, as ren-canv's 2D replay puts it: a linear
 * one along the line through the center at `angle` degrees (0 up, 90
 * right), as long as CSS makes it; a radial one from the center to the
 * farthest corner. Returns x0, y0, x1, y1 and the radius.
 * @param {number} x @param {number} y @param {number} right @param {number} bottom @param {boolean} radial @param {number} angle
 * @returns {[number, number, number, number, number]}
 */
function line(x, y, right, bottom, radial, angle) {
  const cx = (x + right) / 2;
  const cy = (y + bottom) / 2;
  const w = right - x;
  const h = bottom - y;
  if (radial) return [cx, cy, cx, cy, Math.sqrt(w * w + h * h) / 2];
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half, 0];
}

/** @typedef {import('canvaskit-wasm').CanvasKit} Kit */
/** @typedef {import('canvaskit-wasm').Canvas} Canvas */
/** @typedef {import('canvaskit-wasm').Image} Picture */
/** @typedef {import('ren-canv/backend').Frame} Frame */
/** @typedef {import('ren-canv/backend').Damage} Damage */
/** @typedef {import('./fonts.js').Fonts} Fonts */

/**
 * Loads the encoded bytes of an image source; null when there is none.
 * @typedef {(source: string) => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer | null> | null} Loader
 */

/** An sRGB channel's linear light, by its 8-bit value. */
const LINEAR = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  const c = v / 255;
  LINEAR[v] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * The color of text's second pass, or 0 for none: Chrome's text contrast,
 * which CanvasKit leaves out of its grayscale glyphs (its mask gamma and
 * contrast are set in its build, with no JavaScript API). Skia's contrast
 * lifts a glyph's coverage `a` to `a + c·a·(1 − a)`, with `c` set by the
 * text color alone; a second pass at alpha `c` over the first composes to
 * exactly that. `c = 0.8·(1 − Y/0.3)`, Y the color's linear luminance,
 * matches Chrome's DOM text ink within 2% at 12–20px from black to mid grey
 * (README, Layout). Text with Y ≥ 0.3 gets none: CanvasKit's light text is
 * already as heavy as the DOM's or more, and a pass can only add.
 * @param {number} color ARGB
 */
export function contrast(color) {
  const y = 0.2126 * LINEAR[(color >>> 16) & 255] + 0.7152 * LINEAR[(color >>> 8) & 255] + 0.0722 * LINEAR[color & 255];
  if (y >= 0.3) return 0;
  const alpha = Math.round((color >>> 24) * 0.8 * (1 - y / 0.3));
  return alpha < 4 ? 0 : ((alpha << 24) | (color & 0xffffff)) >>> 0;
}

/**
 * The image cache's size. The cache's contract (ren-canv's Replay2D keeps the same):
 * - nothing is evicted during a frame (`run`): an image a frame draws stays
 *   until the frame ends, however many it draws;
 * - at the end of `run`, the least recently drawn entries that are neither
 *   loading nor drawn since the last whole repaint (a `run` without damage)
 *   go, until at most IMAGES remain (or none of the rest may go): a
 *   damage-only frame skips what lies outside its damage, so an image not
 *   drawn in it may still be on screen;
 * - bounded under damage repaint: a damage-only frame that starts with more
 *   than IMAGES entries beyond what the last whole repaint kept (at least
 *   IMAGES) is drawn whole instead (the same pixels), so what left the
 *   screen may go. Between frames the cache so holds at most that many plus
 *   the new images one frame draws: 2 × IMAGES + 1 for one new image a frame
 *   over at most IMAGES on screen, with no load pending (a load in flight is
 *   kept until it settles). No image on screen is evicted;
 * - a loader that throws or rejects (or gives null, or bytes that do not
 *   decode) marks its entry failed (not loading, no image; kept, so not
 *   retried while cached) and reports the source to `failed` after the
 *   frame; it never aborts the frame;
 * - a load that finishes later, between frames, evicts the same way.
 */
const IMAGES = 32;

/** An image cache entry: decoded, loading or failed. */
class Entry {
  /** @param {Picture | null} image @param {boolean} loading @param {number} drawn */
  constructor(image, loading, drawn) {
    this.image = image;
    this.loading = loading;
    /** The frame (`run`) that last drew it. */
    this.drawn = drawn;
    /** True once its load failed (reported to `failed`). */
    this.failed = false;
  }
}

export class Replay {
  /**
   * @param {Kit} kit @param {Fonts} fonts @param {Loader | null} load @param {() => void} redraw @param {(source: string) => void} [failed] called when a source fails to load or decode
   * @param {(source: string) => void} [forgot] called when a failed source leaves the cache, so a later draw loads it again
   */
  constructor(kit, fonts, load, redraw, failed = () => {}, forgot = () => {}) {
    this.failed = failed;
    this.forgot = forgot;
    this.kit = kit;
    /** The shift of the frame being drawn (`run`). */
    this.sx = 0;
    this.sy = 0;
    this.fonts = fonts;
    this.load = load;
    this.redraw = redraw;
    this.paint = new kit.Paint();
    this.paint.setAntiAlias(true);
    /** The dash of the strokes being drawn, while one is set. @type {any} */
    this.effect = null;
    /** The paint of an opacity layer. */
    this.alpha = new kit.Paint();
    this.rect = new Float32Array(4);
    this.round = new Float32Array(12);
    this.source = new Float32Array(4);
    /** @type {Map<string, Entry>} */
    this.images = new Map();
    /** The count of frames drawn, the current one's stamp. */
    this.frame = 0;
    /** The stamp of the last frame drawn whole (without damage). */
    this.whole = 0;
    /** What the last whole repaint left cached, at least IMAGES: past it by IMAGES, a damage-only frame is drawn whole. */
    this.kept = IMAGES;
    this.closed = false;
  }

  /** @param {number} x @param {number} y @param {number} right @param {number} bottom */
  box(x, y, right, bottom) {
    const r = this.rect;
    r[0] = x;
    r[1] = y;
    r[2] = right;
    r[3] = bottom;
    return r;
  }

  /**
   * A box with its own radius at each corner, read from `o` at `at`
   * (top-left, top-right, bottom-right, bottom-left), each less `less`.
   * @param {number} x @param {number} y @param {number} right @param {number} bottom @param {Float64Array} o @param {number} at @param {number} less
   */
  corners(x, y, right, bottom, o, at, less) {
    const r = this.round;
    r[0] = x;
    r[1] = y;
    r[2] = right;
    r[3] = bottom;
    for (let k = 0; k < 4; k++) r[4 + k * 2] = r[5 + k * 2] = Math.max(0, o[at + k] - less);
    return r;
  }

  /**
   * Dashes the strokes that follow: `count` lengths on and off from
   * `o[at]` (none: solid), their ends round with `cap` 1.
   * @param {number} cap @param {number} count @param {Float64Array} o @param {number} at
   */
  dashed(cap, count, o, at) {
    const paint = this.paint;
    if (this.effect !== null) {
      paint.setPathEffect(null);
      this.effect.delete();
      this.effect = null;
    }
    paint.setStrokeCap(cap === 1 ? this.kit.StrokeCap.Round : this.kit.StrokeCap.Butt);
    if (count === 0) return;
    const lengths = [];
    for (let k = 0; k < count; k++) lengths.push(o[at + k]);
    // Skia wants an even count: SVG repeats an odd list once.
    if (count % 2 === 1) lengths.push(...lengths);
    this.effect = this.kit.PathEffect.MakeDash(lengths, 0);
    paint.setPathEffect(this.effect);
  }

  /**
   * A border with each side's own width and color (ren-canv's edges command
   * at `o[i]`): solid, the ring between the box and its inner box, each
   * side's part cut at the corners' diagonals; dashed or dotted, a stroke
   * along the middle of each side.
   * @param {Canvas} canvas @param {Float64Array} o @param {number} i
   */
  edges(canvas, o, i) {
    const kit = this.kit;
    const paint = this.paint;
    const x = o[i];
    const y = o[i + 1];
    const right = o[i + 2];
    const bottom = o[i + 3];
    const style = o[i + 8];
    const [t, r, b, l] = [o[i + 9], o[i + 10], o[i + 11], o[i + 12]];
    const cut = [
      [x, y, right, y, right - r, y + t, x + l, y + t],
      [right, y, right, bottom, right - r, bottom - b, right - r, y + t],
      [right, bottom, x, bottom, x + l, bottom - b, right - r, bottom - b],
      [x, bottom, x, y, x + l, y + t, x + l, bottom - b],
    ];
    const widths = [t, r, b, l];
    for (let side = 0; side < 4; side++) {
      const w = widths[side];
      const color = o[i + 13 + side];
      if (w <= 0 || color >>> 24 === 0) continue;
      paint.setColorInt(color >>> 0);
      const p = cut[side];
      if (style === 0) {
        const clip = new kit.Path();
        const ring = new kit.Path();
        try {
          clip.moveTo(p[0], p[1]);
          for (let k = 2; k < 8; k += 2) clip.lineTo(p[k], p[k + 1]);
          clip.close();
          const outer = Float32Array.of(x, y, right, bottom, o[i + 4], o[i + 4], o[i + 5], o[i + 5], o[i + 6], o[i + 6], o[i + 7], o[i + 7]);
          const k0 = Math.max(0, o[i + 4] - Math.max(l, t));
          const k1 = Math.max(0, o[i + 5] - Math.max(r, t));
          const k2 = Math.max(0, o[i + 6] - Math.max(r, b));
          const k3 = Math.max(0, o[i + 7] - Math.max(l, b));
          const inner = Float32Array.of(x + l, y + t, right - r, bottom - b, k0, k0, k1, k1, k2, k2, k3, k3);
          ring.addRRect(outer);
          ring.addRRect(inner);
          ring.setFillType(kit.FillType.EvenOdd);
          this.stroke(0, 0);
          canvas.save();
          canvas.clipPath(clip, kit.ClipOp.Intersect, true);
          canvas.drawPath(ring, paint);
          canvas.restore();
        } finally {
          clip.delete();
          ring.delete();
        }
      } else {
        const h = w / 2;
        const dx = side === 1 ? -h : side === 3 ? h : 0;
        const dy = side === 0 ? h : side === 2 ? -h : 0;
        const effect = kit.PathEffect.MakeDash(style === 2 ? [0, 2 * w] : [3 * w, 3 * w], 0);
        const was = this.effect;
        paint.setPathEffect(effect);
        paint.setStrokeCap(style === 2 ? kit.StrokeCap.Round : kit.StrokeCap.Butt);
        this.stroke(1, w);
        canvas.drawLine(p[0] + dx, p[1] + dy, p[2] + dx, p[3] + dy, paint);
        paint.setPathEffect(was);
        paint.setStrokeCap(kit.StrokeCap.Butt);
        effect?.delete();
      }
    }
  }

  /** @param {number} style @param {number} width */
  stroke(style, width) {
    const kit = this.kit;
    if (style === 0) this.paint.setStyle(kit.PaintStyle.Fill);
    else {
      this.paint.setStyle(kit.PaintStyle.Stroke);
      this.paint.setStrokeWidth(width);
    }
  }

  /**
   * Draws a frame on `canvas`, scaled, over a background: all of it, or with
   * `damage`, only inside its rectangles (logical pixels), leaving the
   * pixels outside them as the previous frame left them. Shifted by
   * `shiftX`, `shiftY` logical pixels (a Document's, under a device pixel).
   * @param {Canvas} canvas @param {Frame} frame @param {number} scale @param {number} background ARGB @param {Damage | null} [damage]
   * @param {number} [shiftX] @param {number} [shiftY]
   */
  run(canvas, frame, scale, background, damage = null, shiftX = 0, shiftY = 0) {
    this.frame++;
    this.sx = shiftX;
    this.sy = shiftY;
    // Damage keeps images it skips; past the bound, a whole repaint lets those off screen go.
    if (damage !== null && this.images.size > this.kept + IMAGES) damage = null;
    if (damage === null) this.whole = this.frame;
    if (damage === null) {
      canvas.drawColorInt(background >>> 0, this.kit.BlendMode.Src);
      this.pass(canvas, frame, scale, background, -Infinity, -Infinity, Infinity, Infinity);
    } else {
      const b = damage.box;
      for (let k = 0; k < damage.n * 4; k += 4) this.pass(canvas, frame, scale, background, b[k], b[k + 1], b[k + 2], b[k + 3]);
    }
    this.evict();
    this.fonts.evict();
    if (damage === null) this.kept = Math.max(IMAGES, this.images.size);
  }

  /**
   * Replays the commands that can touch a rectangle, clipped to it; an
   * infinite one replays all without clearing.
   * @param {Canvas} canvas @param {Frame} frame @param {number} scale @param {number} background
   * @param {number} left @param {number} top @param {number} right @param {number} bottom
   */
  pass(canvas, frame, scale, background, left, top, right, bottom) {
    const kit = this.kit;
    const paint = this.paint;
    const fonts = this.fonts;
    const o = frame.ops;
    const texts = frame.texts;
    const base = canvas.save();
    canvas.scale(scale, scale);
    const sx = this.sx ?? 0;
    const sy = this.sy ?? 0;
    const cull = left !== -Infinity;
    if (sx !== 0 || sy !== 0) canvas.translate(sx, sy);
    if (cull) {
      // The rectangle takes the device pixels it touches whole (shifted, or
      // at a fractional scale), as ren-canv's 2D replay does.
      left = Math.floor((left + sx) * scale) / scale - sx;
      top = Math.floor((top + sy) * scale) / scale - sy;
      right = Math.ceil((right + sx) * scale) / scale - sx;
      bottom = Math.ceil((bottom + sy) * scale) / scale - sy;
    }
    if (cull) {
      canvas.clipRect(this.box(left, top, right, bottom), kit.ClipOp.Intersect, false);
      canvas.drawColorInt(background >>> 0, kit.BlendMode.Src);
    }
    // The save count a transform was set at (-1: none): inside one, boxes are not on the screen's axes, so nothing is culled.
    let bent = -1;
    /** The gradient the next fill takes (a Shape figure's fill), set on the paint, or null. @type {any} */
    let shade = null;
    let i = 0;
    let s = 0;
    try {
      while (i < frame.n) {
        const code = o[i++];
        if (cull && bent < 0 && code !== SAVE && code !== RESTORE && code !== CLIP && code !== PATH && code !== LAYER && code !== RCLIP && code !== DASH && code !== GRADIENT && code !== TRANSFORM) {
          let outside;
          if (code === TEXT_OP) {
            const size = o[i + 2];
            outside = o[i + 1] - size * 1.25 > bottom || o[i + 1] + size * 0.5 < top || o[i] > right;
          } else {
            // Rectangles, lines, ovals, borders, shadows and images: their box, grown by a line's width or a blur.
            const pad = code === LINE || code === OVAL ? o[i + 5] + 1 : code === SHADOW ? o[i + 6] * 1.5 + 1 : code === RSHADOW ? o[i + 5] * 1.5 + 1 : 1;
            outside = Math.min(o[i], o[i + 2]) - pad > right || Math.max(o[i], o[i + 2]) + pad < left || Math.min(o[i + 1], o[i + 3]) - pad > bottom || Math.max(o[i + 1], o[i + 3]) + pad < top;
          }
          if (outside) {
            if (code === TEXT_OP || code === IMAGE_OP || code === PICTURE) s++;
            // A shade's figure lies in its box: both are outside.
            else if (code === SHADE) i += o[i + 6] * 2;
            i += operands[code];
            continue;
          }
        }
        switch (code) {
          case SAVE:
            canvas.save();
            continue;
          case RESTORE:
            if (canvas.getSaveCount() > base + 1) canvas.restore();
            if (canvas.getSaveCount() < bent) bent = -1;
            continue;
          case TRANSFORM:
            canvas.concat([o[i], o[i + 2], o[i + 4], o[i + 1], o[i + 3], o[i + 5], 0, 0, 1]);
            if (bent < 0) bent = canvas.getSaveCount();
            break;
          case CLIP:
            canvas.clipRect(this.box(o[i], o[i + 1], o[i + 2], o[i + 3]), kit.ClipOp.Intersect, false);
            break;
          case RCLIP:
            canvas.clipRRect(this.corners(o[i], o[i + 1], o[i + 2], o[i + 3], o, i + 4, 0), kit.ClipOp.Intersect, true);
            break;
          case EDGES:
            this.edges(canvas, o, i);
            break;
          case GRADIENT: {
            const count = o[i + 10];
            const radial = o[i + 8] === 1;
            const [x0, y0, x1, y1, radius] = line(o[i], o[i + 1], o[i + 2], o[i + 3], radial, o[i + 9]);
            const colors = new Uint32Array(count);
            const offsets = new Array(count);
            for (let k = 0; k < count; k++) {
              offsets[k] = o[i + 11 + k * 2];
              colors[k] = o[i + 12 + k * 2] >>> 0;
            }
            const shader = radial ? kit.Shader.MakeRadialGradient([x0, y0], radius, colors, offsets, kit.TileMode.Clamp) : kit.Shader.MakeLinearGradient([x0, y0], [x1, y1], colors, offsets, kit.TileMode.Clamp);
            this.stroke(0, 0);
            // Opaque: the shader's colors alone, not the alpha of the fill before.
            paint.setColorInt(0xff000000);
            paint.setShader(shader);
            canvas.drawRRect(this.corners(o[i], o[i + 1], o[i + 2], o[i + 3], o, i + 4, 0), paint);
            paint.setShader(null);
            shader.delete();
            i += count * 2;
            break;
          }
          case SHADE: {
            const count = o[i + 6];
            const radial = o[i + 4] === 1;
            const [x0, y0, x1, y1, radius] = line(o[i], o[i + 1], o[i + 2], o[i + 3], radial, o[i + 5]);
            const colors = new Uint32Array(count);
            const offsets = new Array(count);
            for (let k = 0; k < count; k++) {
              offsets[k] = o[i + 7 + k * 2];
              colors[k] = o[i + 8 + k * 2] >>> 0;
            }
            shade = radial ? kit.Shader.MakeRadialGradient([x0, y0], radius, colors, offsets, kit.TileMode.Clamp) : kit.Shader.MakeLinearGradient([x0, y0], [x1, y1], colors, offsets, kit.TileMode.Clamp);
            paint.setShader(shade);
            i += count * 2 + operands[code];
            continue;
          }
          case DASH:
            this.dashed(o[i], o[i + 1], o, i + 2);
            i += o[i + 1];
            break;
          case RROUND:
            this.stroke(0, 0);
            paint.setColorInt(o[i + 4] >>> 0);
            canvas.drawRRect(this.corners(o[i], o[i + 1], o[i + 2], o[i + 3], o, i + 5, 0), paint);
            break;
          case RBORDER: {
            // A stroke inside the box: its middle half a width in, each radius following it.
            const w = o[i + 5];
            this.stroke(1, w);
            paint.setColorInt(o[i + 4] >>> 0);
            canvas.drawRRect(this.corners(o[i] + w / 2, o[i + 1] + w / 2, o[i + 2] - w / 2, o[i + 3] - w / 2, o, i + 6, w / 2), paint);
            break;
          }
          case RSHADOW: {
            this.stroke(0, 0);
            paint.setColorInt(o[i + 4] >>> 0);
            const blur = o[i + 5];
            const filter = blur > 0 ? kit.MaskFilter.MakeBlur(kit.BlurStyle.Normal, blur / 2, true) : null;
            paint.setMaskFilter(filter);
            canvas.drawRRect(this.corners(o[i], o[i + 1], o[i + 2], o[i + 3], o, i + 6, 0), paint);
            paint.setMaskFilter(null);
            filter?.delete();
            break;
          }
          case TEXT_OP: {
            this.stroke(0, 0);
            const color = o[i + 3] >>> 0;
            const flags = o[i + 4];
            const font = fonts.font(o[i + 2], flags);
            const given = texts[s++];
            const rtl = (flags & RTL) !== 0;
            const second = contrast(color);
            const glyphs = fonts.glyphs(given, o[i + 2], flags);
            if (glyphs !== null) {
              // Shaped: its glyphs at their places, from its left edge.
              const x = rtl ? o[i] - glyphs.width : o[i];
              paint.setColorInt(color);
              canvas.drawGlyphs(glyphs.ids, glyphs.places, x, o[i + 1], font, paint);
              if (second !== 0) {
                paint.setColorInt(second);
                canvas.drawGlyphs(glyphs.ids, glyphs.places, x, o[i + 1], font, paint);
              }
              break;
            }
            // Right to left: drawn glyph by glyph from its left edge, its code points reversed and mirrored.
            const text = rtl ? reversed(given) : given;
            const x = rtl ? o[i] - fonts.width(given, o[i + 2], flags) : o[i];
            paint.setColorInt(color);
            canvas.drawText(text, x, o[i + 1], paint, font);
            if (second !== 0) {
              paint.setColorInt(second);
              canvas.drawText(text, x, o[i + 1], paint, font);
            }
            break;
          }
          case BORDER: {
            // A stroke inside the box: its middle half a width in, the radius following it.
            const w = o[i + 6];
            this.stroke(1, w);
            paint.setColorInt(o[i + 4] >>> 0);
            const r = this.round;
            r[0] = o[i] + w / 2;
            r[1] = o[i + 1] + w / 2;
            r[2] = o[i + 2] - w / 2;
            r[3] = o[i + 3] - w / 2;
            for (let k = 4; k < 12; k++) r[k] = Math.max(0, o[i + 5] - w / 2);
            canvas.drawRRect(r, paint);
            break;
          }
          case SHADOW: {
            this.stroke(0, 0);
            paint.setColorInt(o[i + 4] >>> 0);
            const blur = o[i + 6];
            const filter = blur > 0 ? kit.MaskFilter.MakeBlur(kit.BlurStyle.Normal, blur / 2, true) : null;
            paint.setMaskFilter(filter);
            const r = this.round;
            r[0] = o[i];
            r[1] = o[i + 1];
            r[2] = o[i + 2];
            r[3] = o[i + 3];
            for (let k = 4; k < 12; k++) r[k] = o[i + 5];
            canvas.drawRRect(r, paint);
            paint.setMaskFilter(null);
            filter?.delete();
            break;
          }
          case LAYER:
            this.alpha.setAlphaf(o[i]);
            canvas.saveLayer(this.alpha);
            break;
          case RECT:
            this.stroke(0, 0);
            paint.setColorInt(shade === null ? o[i + 4] >>> 0 : 0xff000000);
            canvas.drawRect(this.box(o[i], o[i + 1], o[i + 2], o[i + 3]), paint);
            break;
          case ROUND: {
            this.stroke(0, 0);
            paint.setColorInt(shade === null ? o[i + 4] >>> 0 : 0xff000000);
            const r = this.round;
            r[0] = o[i];
            r[1] = o[i + 1];
            r[2] = o[i + 2];
            r[3] = o[i + 3];
            for (let k = 4; k < 12; k++) r[k] = o[i + 5];
            canvas.drawRRect(r, paint);
            break;
          }
          case LINE:
            this.stroke(1, o[i + 5]);
            paint.setColorInt(o[i + 4] >>> 0);
            canvas.drawLine(o[i], o[i + 1], o[i + 2], o[i + 3], paint);
            break;
          case OVAL:
            this.stroke(o[i + 5] > 0 ? 1 : 0, o[i + 5]);
            paint.setColorInt(shade === null ? o[i + 4] >>> 0 : 0xff000000);
            canvas.drawOval(this.box(o[i], o[i + 1], o[i + 2], o[i + 3]), paint);
            break;
          case PATH: {
            const stroke = o[i + 1];
            const closed = o[i + 2] !== 0;
            const count = o[i + 3];
            paint.setColorInt(shade === null ? o[i] >>> 0 : 0xff000000);
            this.stroke(!closed || stroke > 0 ? 1 : 0, stroke > 0 ? stroke : 1);
            const path = new kit.Path();
            try {
              const p = i + 4;
              path.moveTo(o[p], o[p + 1]);
              for (let k = 2; k < count; k += 2) path.lineTo(o[p + k], o[p + k + 1]);
              if (closed) path.close();
              canvas.drawPath(path, paint);
            } finally {
              path.delete();
            }
            i += count;
            break;
          }
          case PICTURE: {
            const picture = this.image(texts[s++]);
            if (picture !== null) {
              const from = this.source;
              from[0] = 0;
              from[1] = 0;
              from[2] = picture.width();
              from[3] = picture.height();
              const [l, t, r, b] = fitted(from[2], from[3], o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 4]);
              this.stroke(0, 0);
              // Opaque: an image takes the paint's alpha, which the last fill left.
              paint.setColorInt(0xff000000);
              canvas.save();
              canvas.clipRect(this.box(o[i], o[i + 1], o[i + 2], o[i + 3]), kit.ClipOp.Intersect, true);
              canvas.drawImageRect(picture, from, this.box(l, t, r, b), paint);
              canvas.restore();
            }
            break;
          }
          case IMAGE_OP: {
            const picture = this.image(texts[s++]);
            if (picture !== null) {
              const from = this.source;
              from[0] = 0;
              from[1] = 0;
              from[2] = picture.width();
              from[3] = picture.height();
              this.stroke(0, 0);
              paint.setColorInt(0xff000000);
              canvas.drawImageRect(picture, from, this.box(o[i], o[i + 1], o[i + 2], o[i + 3]), paint);
            }
            break;
          }
          default:
            throw new Error(`REN skia: unknown opcode ${code}`);
        }
        // A shade is its next fill's alone.
        if (shade !== null) {
          paint.setShader(null);
          shade.delete();
          shade = null;
        }
        i += operands[code];
      }
    } finally {
      if (shade !== null) {
        paint.setShader(null);
        shade.delete();
      }
      canvas.restoreToCount(base);
      this.dashed(0, 0, o, 0);
    }
  }

  /** The decoded image of a source, starting its load when it is new. @param {string} source @returns {Picture | null} */
  image(source) {
    const known = this.images.get(source);
    if (known !== undefined) {
      known.drawn = this.frame;
      this.images.delete(source);
      this.images.set(source, known);
      return known.image;
    }
    const entry = new Entry(null, true, this.frame);
    this.images.set(source, entry);
    const load = this.load;
    // A source loaded at once draws in this frame; a later one redraws.
    /** @param {Uint8Array | ArrayBuffer | null} bytes @param {boolean} later */
    const done = (bytes, later) => {
      entry.loading = false;
      if (this.closed) return;
      if (bytes !== null) entry.image = this.kit.MakeImageFromEncoded(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      if (entry.image === null) {
        // No bytes, or none that decode: its Images hear `error`.
        // Told after the frame that asked for it (a handler may change the view).
        if (load !== null) {
          entry.failed = true;
          queueMicrotask(() => this.failed(source));
        }
        return;
      }
      if (later) {
        this.evict();
        this.redraw();
      }
    };
    try {
      const bytes = load === null ? null : load(source);
      if (bytes instanceof Promise) bytes.then(b => done(b, true), () => done(null, true));
      else done(bytes, false);
    } catch {
      done(null, false);
    }
    return entry.image;
  }

  /** Between frames: over the size, drops the least recently drawn that is neither loading nor drawn since the last whole repaint. */
  evict() {
    for (const [source, entry] of this.images) {
      // Least recently drawn first: from the first drawn since the last whole repaint on, all were.
      if (this.images.size <= IMAGES || entry.drawn >= this.whole) break;
      if (entry.loading) continue;
      if (entry.image !== null) entry.image.delete();
      this.images.delete(source);
      // A failed source is loaded again when next drawn: its failure is forgotten.
      if (entry.failed) this.forgot(source);
    }
  }

  close() {
    this.closed = true;
    for (const entry of this.images.values()) if (entry.image !== null) entry.image.delete();
    this.images.clear();
    this.paint.delete();
    this.alpha.delete();
  }
}
