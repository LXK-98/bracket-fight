const MAX_EDGE = 1600;
const QUALITY = 0.85;
const MAX_INPUT_BYTES = 40 * 1024 * 1024;

type Drawable = { source: CanvasImageSource; width: number; height: number; close: () => void };

function isHeic(file: File) {
  return /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

export function looksLikeImage(file: File) {
  return file.type.startsWith('image/') || isHeic(file) || /\.(jpe?g|png|webp|gif|avif)$/i.test(file.name);
}

async function decode(blob: Blob): Promise<Drawable> {
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall back to <img>, which some browsers decode more formats with (e.g. HEIC in Safari) */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

/**
 * Decode any image the browser (or heic2any) can read, downscale it so the
 * longest edge is at most 1600px, and re-encode as WebP (JPEG where WebP
 * encoding is unsupported, e.g. Safari). Strips EXIF/location data as a bonus.
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (!looksLikeImage(file)) throw new Error('That file is not an image.');
  if (file.size > MAX_INPUT_BYTES) throw new Error('That image is too large.');

  let drawable: Drawable;
  try {
    drawable = await decode(file);
  } catch {
    if (!isHeic(file)) throw new Error("Couldn't read that image. Try a JPEG or PNG.");
    try {
      const { default: heic2any } = await import('heic2any');
      const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
      drawable = await decode(Array.isArray(converted) ? converted[0] : converted);
    } catch {
      throw new Error("Couldn't convert that HEIC photo. Try taking a screenshot of it, or use JPEG.");
    }
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(drawable.width, drawable.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(drawable.width * scale));
    canvas.height = Math.max(1, Math.round(drawable.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser cannot process images.');
    ctx.fillStyle = '#fff'; // transparent PNGs would otherwise turn black in JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(drawable.source, 0, 0, canvas.width, canvas.height);
    const webp = await toBlob(canvas, 'image/webp');
    if (webp && webp.type === 'image/webp') return webp;
    const jpeg = await toBlob(canvas, 'image/jpeg');
    if (!jpeg) throw new Error('Could not compress that image.');
    return jpeg;
  } finally {
    drawable.close();
  }
}
