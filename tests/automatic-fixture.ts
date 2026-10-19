import sharp from 'sharp';

export const AUTOMATIC_FIXTURE = {
  width: 480,
  height: 400,
  arrow: { x: 40, y: 100 },
  exteriorGlyph: { x: 40, y: 48 },
  exteriorTable: { x: 40, y: 356 },
  seam: { x: 184, y: 240 },
  garmentDetail: { x: 156, y: 204 },
  manualFill: { x: 160, y: 260 },
} as const;

/** A deterministic vector-rendered garment sheet with removable exterior marks. */
export async function makeAutomaticFixture(): Promise<Buffer> {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="400" viewBox="0 0 120 100">
    <rect width="120" height="100" fill="#f5f5f2"/>
    <rect x="2" y="2" width="20" height="4" fill="#c7c7c3" opacity=".45"/>
    <ellipse cx="42" cy="51" rx="19" ry="28" fill="#aaa9a4" opacity=".10"/>
    <ellipse cx="83" cy="51" rx="19" ry="28" fill="#aaa9a4" opacity=".10"/>
    <path d="M27 29 L35 21 L42 25 L49 21 L57 29 L53 43 L50 40 Q52 55 49 76 Q42 78 34 76 Q31 55 34 40 L31 43 Z
             M68 29 L76 21 L83 25 L90 21 L98 29 L94 43 L91 40 Q93 55 90 76 Q83 78 75 76 Q72 55 75 40 L72 43 Z"
          fill="#eee6d9" stroke="#252422" stroke-width="1.1" stroke-linejoin="round"/>
    <path d="M42 27 Q43 34 46 36 L46 76 M83 27 Q84 34 87 36 L87 76"
          fill="none" stroke="#37342f" stroke-width=".9"/>
    <path d="M35 44 L35 75 M50 44 L50 75 M76 44 L76 75 M91 44 L91 75"
          fill="none" stroke="#736e64" stroke-width=".55" stroke-dasharray="1 1.5"/>
    <circle cx="39" cy="51" r=".8" fill="#252422"/><circle cx="79" cy="55" r=".8" fill="#252422"/>
    <path d="M7 25 H20 M7 25 L12 21 M7 25 L12 29" fill="none" stroke="#f51816" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M7 8 L11 16 L15 8 M9 12 H13" fill="none" stroke="#292724" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M2 83 H19 M2 89 H19 M2 95 H19 M2 83 V95 M10 83 V95 M19 83 V95" fill="none" stroke="#38342f" stroke-width=".9"/>
  </svg>`);
  return sharp({ create: { width: AUTOMATIC_FIXTURE.width, height: AUTOMATIC_FIXTURE.height, channels: 4, background: '#fff' } })
    .composite([{ input: svg }])
    .png()
    .toBuffer();
}
