// Velza Global logo, from the master artwork in the brand book (./brand-assets). Never redrawn or recoloured:
// the black (positive) version on light backgrounds, the white (reversed) one on dark backgrounds.
// The V symbol alone is used at small digital sizes (brand book p. 21); the full lock-up only where
// VELZA and GLOBAL stay legible. object-contain: the artwork keeps its proportions whatever box it is given.

import Image, { type StaticImageData } from "next/image";
// Static imports: served from /_next/static (open to signed-out visitors: sign-in page, public QR page).
import logoBlack from "./brand-assets/velza-logo-black.png";
import logoWhite from "./brand-assets/velza-logo-white.png";
import vBlack from "./brand-assets/velza-v-black.png";
import vWhite from "./brand-assets/velza-v-white.png";

const ART: Record<"v" | "logo", Record<"black" | "white", StaticImageData>> = {
  v: { black: vBlack, white: vWhite },
  logo: { black: logoBlack, white: logoWhite },
};

type Tone = "auto" | "on-light" | "on-dark";

const V_RATIO = 582 / 500; // width / height of the V symbol artwork
const LOCKUP_RATIO = 582 / 753; // width / height of the V + VELZA + GLOBAL lock-up

function Variant({ name, tone, width, height, alt, className }: { name: "v" | "logo"; tone: Tone; width: number; height: number; alt: string; className?: string }) {
  const img = (color: "black" | "white", extra?: string) => (
    <Image src={ART[name][color]} alt={alt} width={width} height={height} unoptimized priority className={["object-contain", extra, className].filter(Boolean).join(" ")} draggable={false} />
  );
  if (tone === "on-light") return img("black");
  if (tone === "on-dark") return img("white");
  return (
    <>
      {img("black", "dark:hidden")}
      {img("white", "hidden dark:block")}
    </>
  );
}

/** The V symbol, `height` px tall. */
export function VelzaSymbol({ height = 24, tone = "auto", className }: { height?: number; tone?: Tone; className?: string }) {
  return <Variant name="v" tone={tone} width={Math.round(height * V_RATIO)} height={height} alt="Velza Global" className={className} />;
}

/** The complete lock-up (V, VELZA, GLOBAL), `height` px tall. Keep it large enough to read GLOBAL. */
export function VelzaLogo({ height = 96, tone = "auto", className }: { height?: number; tone?: Tone; className?: string }) {
  return <Variant name="logo" tone={tone} width={Math.round(height * LOCKUP_RATIO)} height={height} alt="Velza Global" className={className} />;
}
