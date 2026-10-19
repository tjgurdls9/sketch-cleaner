import path from 'node:path';
import sharp from 'sharp';
import type { Pixels } from '../shared/types';
import { MAX_FILE_BYTES, MAX_PIXELS } from '../shared/types';
import { UserError } from './errors';

export interface DecodedImage {
  pixels: Pixels;
  format: 'jpeg' | 'png';
}

export async function decodeImage(name: string, source: Uint8Array): Promise<DecodedImage> {
  if (!(source instanceof Uint8Array) || source.byteLength === 0) throw new UserError('이미지 파일이 비어 있습니다.');
  if (source.byteLength > MAX_FILE_BYTES) throw new UserError('입력 파일은 50MB 이하여야 합니다.');

  const extension = path.extname(name).toLowerCase();
  const expectedFormat = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension === '.png' ? 'png' : null;
  if (!expectedFormat) throw new UserError('JPEG 또는 PNG 형식의 파일만 열 수 있습니다.');
  const signatureMatches = expectedFormat === 'png'
    ? source.byteLength >= 8 && Buffer.from(source.buffer, source.byteOffset, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : source.byteLength >= 3 && source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff;
  if (!signatureMatches) throw new UserError('파일 확장자와 실제 이미지 형식이 일치하지 않습니다.');

  try {
    const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    const input = sharp(bytes, { failOn: 'error' });
    const metadata = await input.metadata();
    if (metadata.format !== expectedFormat) throw new UserError('파일 확장자와 실제 이미지 형식이 일치하지 않습니다.');
    if ((metadata.pages ?? 1) !== 1) throw new UserError('한 장짜리 JPEG 또는 PNG만 열 수 있습니다.');
    if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) {
      throw new UserError('이미지는 2,500만 픽셀 이하여야 합니다.');
    }

    const decoded = await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
      .rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width * decoded.info.height > MAX_PIXELS) throw new UserError('이미지는 2,500만 픽셀 이하여야 합니다.');
    return {
      pixels: { width: decoded.info.width, height: decoded.info.height, data: new Uint8ClampedArray(decoded.data) },
      format: expectedFormat,
    };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError('이미지를 읽을 수 없습니다. 손상되었거나 지원하지 않는 파일입니다.');
  }
}
