// Barcode SVG generation with bwip-js (shared by the print view and tests).

import bwipjs from "bwip-js/browser";

export const CODE128_OPTIONS = { bcid: "code128", scale: 1, height: 10, includetext: false, paddingwidth: 0, paddingheight: 0 } as const;
/** QR settings of the lot stickers printed before they became barcode-only; the scanners still read those QR codes. */
export const QR_OPTIONS = { bcid: "qrcode", eclevel: "M", scale: 1, paddingwidth: 0, paddingheight: 0 } as const;

/** SVG that stretches to its container (sizes are set in mm by the caller). */
function stretch(svg: string): string {
  return svg.replace("<svg ", `<svg width="100%" height="100%" preserveAspectRatio="none" shape-rendering="crispEdges" `);
}

export function code128Svg(text: string): string {
  return stretch(bwipjs.toSVG({ ...CODE128_OPTIONS, text }));
}
