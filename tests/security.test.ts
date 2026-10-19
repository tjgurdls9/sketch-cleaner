import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { decodeImage } from '../src/main/image';
import { CHATGPT_URL, isTrustedSender, safeErrorMessage } from '../src/main/security';

describe('image import trust boundary', () => {
  it('applies JPEG EXIF orientation before returning editor pixels', async () => {
    const bytes = await sharp({
      create: { width: 2, height: 3, channels: 3, background: { r: 20, g: 40, b: 60 } },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();

    const result = await decodeImage('photo.jpg', bytes);
    expect([result.pixels.width, result.pixels.height]).toEqual([3, 2]);
  });

  it('requires an allowed extension to match the decoded format', async () => {
    const png = await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'white' },
    }).png().toBuffer();

    await expect(decodeImage('photo.jpg', png)).rejects.toThrow(/형식|확장자/);
    await expect(decodeImage('photo.webp', png)).rejects.toThrow(/형식|확장자/);
  });

  it('rejects over-limit input bytes before decoding', async () => {
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1);
    await expect(decodeImage('photo.png', oversized)).rejects.toThrow(/50MB|50MB|용량/);
  });

  it('rejects more than 25 million pixels from metadata before decoding', async () => {
    const oversized = await sharp({
      create: { width: 5001, height: 5000, channels: 3, background: 'white' },
    }).png().toBuffer();
    await expect(decodeImage('large.png', oversized)).rejects.toThrow(/2,500만|25MP|픽셀/);
  });

  it('returns a Korean error for malformed image data', async () => {
    await expect(decodeImage('broken.png', Buffer.from('not an image'))).rejects.toThrow(/[가-힣]/);
  });
});

describe('Electron boundary helpers', () => {
  it('accepts IPC only from the registered main window', () => {
    expect(isTrustedSender(17, 17)).toBe(true);
    expect(isTrustedSender(18, 17)).toBe(false);
  });

  it('uses only the fixed ChatGPT site and hides unexpected internal errors', () => {
    expect(CHATGPT_URL).toBe('https://chatgpt.com/');
    const error = new Error('/Users/private/Pictures/source.png: decoder internals');
    expect(safeErrorMessage(error)).not.toContain('/Users/private');
    expect(safeErrorMessage(error)).toMatch(/[가-힣]/);
  });
});
