import sharp from 'sharp';

export const AI_FIXTURE = {
  width: 960,
  height: 720,
  english: { left: 42, top: 34, right: 300, bottom: 85 },
  korean: { left: 42, top: 91, right: 300, bottom: 136 },
  tableInk: { x: 66, y: 530 },
  redArrow: { x: 273, y: 250 },
  manualFix: { x: 464, y: 370 },
  garmentSeam: { x: 424, y: 227 },
  garmentButton: { x: 418, y: 292 },
  garmentStitch: { x: 380, y: 242 },
} as const;

/**
 * Synthetic apparel sheet for local detector integration tests. It includes
 * printed Latin and Korean labels outside two garments, small garment details,
 * a ruled table, and a red annotation arrow. No network or user image is used.
 */
export async function makeAIFixture(): Promise<Buffer> {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720" viewBox="0 0 960 720">
    <defs>
      <linearGradient id="fabric" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#f3eee4"/><stop offset=".55" stop-color="#e7dfd2"/><stop offset="1" stop-color="#d9d1c4"/>
      </linearGradient>
      <linearGradient id="trouser" x1="0" x2="1">
        <stop offset="0" stop-color="#d9e0e4"/><stop offset=".5" stop-color="#eef0ed"/><stop offset="1" stop-color="#cbd4d9"/>
      </linearGradient>
    </defs>
    <rect width="960" height="720" fill="#f8f7f3"/>
    <rect x="18" y="18" width="924" height="684" rx="4" fill="none" stroke="#d7d4ce" stroke-width="2"/>

    <text x="48" y="72" font-family="Arial, sans-serif" font-size="32" font-weight="700" letter-spacing="1" fill="#30302e">SIZE 95</text>
    <text x="48" y="122" font-family="Malgun Gothic, Arial, sans-serif" font-size="26" font-weight="600" fill="#30302e">소매 길이 64cm</text>
    <text x="48" y="164" font-family="Arial, sans-serif" font-size="22" font-weight="600" letter-spacing="1" fill="#4c4a46">COTTON 100%</text>

    <ellipse cx="416" cy="330" rx="116" ry="214" fill="#45433e" opacity=".07"/>
    <ellipse cx="680" cy="428" rx="124" ry="214" fill="#45433e" opacity=".07"/>

    <path d="M370 174 L399 148 L424 159 L451 148 L478 174 L518 231 L490 248 L472 218 L483 489 Q418 504 350 489 L360 218 L342 248 L312 231 Z"
      fill="url(#fabric)" stroke="#262522" stroke-width="5" stroke-linejoin="round"/>
    <path d="M399 150 Q399 187 424 197 Q449 187 451 150" fill="#f8f7f3" stroke="#37352f" stroke-width="4"/>
    <path d="M424 199 L424 484 M367 235 L375 478 M482 235 L474 478" fill="none" stroke="#5c574e" stroke-width="3"/>
    <path d="M355 460 Q418 470 479 460 M361 474 Q418 484 477 474" fill="none" stroke="#817a6d" stroke-width="2"/>
    <path d="M380 241 L380 442 M468 241 L468 442" fill="none" stroke="#918a7d" stroke-width="2" stroke-dasharray="2 7"/>
    <circle cx="418" cy="260" r="4" fill="#282723"/>
    <circle cx="418" cy="292" r="4" fill="#282723"/>
    <circle cx="418" cy="324" r="4" fill="#282723"/>
    <path d="M406 259 L430 259 M406 291 L430 291 M406 323 L430 323" stroke="#6f695e" stroke-width="1.5"/>
    <path d="M454 365 Q460 359 465 366 L470 375" fill="none" stroke="#ed211d" stroke-width="5" stroke-linecap="round"/>

    <path d="M567 267 Q622 251 686 262 L788 278 L773 366 L722 358 L711 629 L650 629 L637 418 L622 629 L559 629 L567 360 L519 370 L510 289 Z"
      fill="url(#trouser)" stroke="#262522" stroke-width="5" stroke-linejoin="round"/>
    <path d="M626 270 Q630 315 649 337 L637 418 M649 337 Q673 317 680 268 M650 350 L650 620 M652 357 L707 356"
      fill="none" stroke="#4b4c49" stroke-width="3"/>
    <path d="M570 355 L618 362 M722 358 L770 366 M560 613 L620 613 M650 613 L709 613"
      fill="none" stroke="#666762" stroke-width="2"/>
    <circle cx="646" cy="284" r="4" fill="#252522"/>

    <path d="M253 250 L300 250 M253 250 L272 235 M253 250 L272 265" fill="none" stroke="#ee1715" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="54" y="508" font-family="Arial, sans-serif" font-size="20" font-weight="600" fill="#343330">MEASUREMENTS</text>
    <path d="M50 530 H248 M50 568 H248 M50 606 H248 M50 644 H248 M50 530 V644 M116 530 V644 M182 530 V644 M248 530 V644"
      fill="none" stroke="#33322f" stroke-width="3"/>
    <path d="M73 550 H99 M139 550 H165 M205 588 H231" fill="none" stroke="#5c5953" stroke-width="2"/>
  </svg>`);

  return sharp({
    create: {
      width: AI_FIXTURE.width,
      height: AI_FIXTURE.height,
      channels: 4,
      background: '#f8f7f3',
    },
  })
    .composite([{ input: svg }])
    .png()
    .toBuffer();
}
