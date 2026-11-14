// Camera scanning session around @zxing/browser (the decoder is injected so the session logic can be tested with a
// mocked camera). One session at a time per page; every media track is stopped on stop() — the camera light goes off.

export type CameraErrorKind = "INSECURE" | "UNSUPPORTED" | "DENIED" | "NOT_FOUND" | "IN_USE" | "FAILED";

export class CameraError extends Error {
  constructor(
    public readonly kind: CameraErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CameraError";
  }
}

const MESSAGES: Record<CameraErrorKind, string> = {
  INSECURE: "The camera only works on a secure page (https:// or localhost). Ask your administrator for the https address, or use a USB/Bluetooth scanner or type the code.",
  UNSUPPORTED: "This browser cannot use the camera. Use a current Chrome (Android) or Safari (iPhone), a USB/Bluetooth scanner, or type the code.",
  DENIED: "Camera permission was refused. Allow the camera for this site in the browser's site settings, then press Start camera again — or use a scanner or type the code.",
  NOT_FOUND: "No camera was found on this device. Use a USB/Bluetooth scanner or type the code.",
  IN_USE: "The camera is busy in another app or tab. Close it there, then press Start camera again.",
  FAILED: "The camera could not start. Press Start camera again, or use a scanner or type the code.",
};

export function cameraErrorMessage(kind: CameraErrorKind): string {
  return MESSAGES[kind];
}

/** Browser error (DOMException name) → our kind. */
export function toCameraError(e: unknown): CameraError {
  if (e instanceof CameraError) return e;
  const name = (e as { name?: string } | null)?.name ?? "";
  const kind: CameraErrorKind =
    name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError"
      ? "DENIED"
      : name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError"
        ? "NOT_FOUND"
        : name === "NotReadableError" || name === "TrackStartError" || name === "AbortError"
          ? "IN_USE"
          : "FAILED";
  return new CameraError(kind, MESSAGES[kind]);
}

export interface DecoderControls {
  stop(): void;
}

/** Starts the camera with `constraints`, shows it in `video` and calls `onText` for each decoded frame. */
export interface Decoder {
  start(constraints: MediaStreamConstraints, video: VideoLike, onText: (text: string) => void): Promise<DecoderControls>;
}

export interface VideoLike {
  srcObject: MediaProvider | MediaStream | null;
}

export interface CameraEnv {
  isSecureContext: boolean;
  mediaDevices?: Pick<MediaDevices, "getUserMedia" | "enumerateDevices">;
}

export interface CameraInfo {
  deviceId: string;
  label: string;
}

/**
 * Requested size. Without one, browsers give 640×480: a pack sticker's Code 128 bars (≈0.33 mm) are then under
 * 2 px wide and can't be read, while the lot sticker's QR still is. 1280×720 or more reads both.
 */
export const CAMERA_SIZE = { width: { ideal: 1920 }, height: { ideal: 1080 } } as const;
/** Below this width, small (pack) barcodes need the sticker held close to the camera. */
export const LOW_RES_WIDTH = 1280;

/** The session currently holding the camera on this page, if any. */
const camera: { active: CameraSession | null } = { active: null };

/** The session currently holding the camera, if any (for tests and diagnostics). */
export function activeCameraSession() {
  return camera.active;
}

export class CameraSession {
  state: "idle" | "starting" | "running" | "stopped" = "idle";
  torchSupported = false;
  torchOn = false;
  /** The size the camera actually gave (null until running, or if the browser doesn't say). */
  resolution: { width: number; height: number } | null = null;
  private controls: DecoderControls | null = null;
  private generation = 0;

  constructor(
    private readonly video: VideoLike,
    private readonly decoder: Decoder,
    private readonly env: CameraEnv,
    private readonly onText: (text: string) => void,
  ) {}

  static async listCameras(env: CameraEnv): Promise<CameraInfo[]> {
    if (!env.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await env.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === "videoinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    } catch {
      return [];
    }
  }

  /** Start (or restart on another camera). Rear camera preferred when no device is chosen. */
  async start(deviceId?: string): Promise<void> {
    if (!this.env.isSecureContext) throw new CameraError("INSECURE", MESSAGES.INSECURE);
    if (!this.env.mediaDevices?.getUserMedia) throw new CameraError("UNSUPPORTED", MESSAGES.UNSUPPORTED);
    if (camera.active && camera.active !== this) camera.active.stop(); // only one camera session at a time
    camera.active = this;
    const gen = ++this.generation;
    this.state = "starting";
    // Attempts share one <video>, so they run one after another: an older attempt still opening (React runs the
    // opening effect twice in development) must finish and clean up before the next one attaches its stream —
    // otherwise its clean-up clears the video under the newer camera and the preview stays black.
    const run = this.pending.then(() => this.open(gen, deviceId));
    this.pending = run.catch(() => undefined);
    return run;
  }

  private pending: Promise<unknown> = Promise.resolve();

  private async open(gen: number, deviceId?: string): Promise<void> {
    if (gen !== this.generation) return; // superseded while waiting for the previous attempt
    this.stopStream();
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: deviceId ? { deviceId: { exact: deviceId }, ...CAMERA_SIZE } : { facingMode: { ideal: "environment" }, ...CAMERA_SIZE },
    };
    let controls: DecoderControls;
    try {
      controls = await this.decoder.start(constraints, this.video, (text) => {
        if (this.state === "running" && gen === this.generation) this.onText(text);
      });
    } catch (e) {
      // Superseded by a newer start() or by stop() while the camera was opening (e.g. React running the opening
      // effect twice in development): the browser aborts this attempt's video.play() ("interrupted by a new load
      // request"). That is not a camera failure, and the stream now belongs to the newer attempt — leave it alone.
      if (gen !== this.generation) return;
      this.state = "idle";
      this.stopStream();
      throw toCameraError(e);
    }
    if (gen !== this.generation || this.state !== "starting") {
      // stop() (or another start) happened while the camera was opening: release what we just got.
      controls.stop();
      this.stopTracks();
      return;
    }
    this.controls = controls;
    this.state = "running";
    const track = this.track();
    this.torchSupported = !!(track?.getCapabilities?.() as { torch?: boolean } | undefined)?.torch;
    this.torchOn = false;
    // Keep refocusing on close-up stickers where the camera supports it (many webcams ignore it).
    await track?.applyConstraints?.({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => undefined);
    const s = track?.getSettings?.();
    this.resolution = s?.width && s.height ? { width: s.width, height: s.height } : null;
  }

  async setTorch(on: boolean): Promise<boolean> {
    const track = this.track();
    if (!track || !this.torchSupported) return false;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      this.torchOn = on;
      return true;
    } catch {
      return false;
    }
  }

  /** Stop decoding and release the camera. Safe to call more than once. */
  stop() {
    this.generation++;
    this.stopStream();
    this.state = "stopped";
    if (camera.active === this) camera.active = null;
  }

  private stopStream() {
    this.controls?.stop();
    this.controls = null;
    this.stopTracks();
    this.torchSupported = false;
    this.torchOn = false;
    this.resolution = null;
  }

  private stopTracks() {
    const stream = this.video.srcObject as MediaStream | null;
    stream?.getTracks?.().forEach((t) => t.stop());
    this.video.srcObject = null;
  }

  private track(): MediaStreamTrack | undefined {
    return (this.video.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
  }
}

/** The real decoder: @zxing/browser, Code 128 (pack and lot barcodes) and QR (lot stickers). Loaded on demand. */
/**
 * @zxing/browser 0.2.1 bug: HTMLCanvasElementLuminanceSource never initialises `tempCanvasElement`, but only creates the
 * temporary canvas when it is exactly `null`. With TRY_HARDER the barcode reader also tries each frame rotated 90°, and
 * that rotation then throws "Could not create a Canvas element." on every frame (console noise, and sideways barcodes
 * are never read). Defaulting the field to null on the prototype lets the library create its canvas as intended.
 */
export function fixRotatedScans(proto: object) {
  const p = proto as { tempCanvasElement?: unknown };
  if (p.tempCanvasElement === undefined) p.tempCanvasElement = null;
}

export async function zxingDecoder(): Promise<Decoder> {
  const [{ BrowserMultiFormatReader, HTMLCanvasElementLuminanceSource }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
  fixRotatedScans(HTMLCanvasElementLuminanceSource.prototype);
  const hints = new Map<import("@zxing/library").DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE]],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 });
  return {
    start: (constraints, video, onText) =>
      reader.decodeFromConstraints(constraints, video as HTMLVideoElement, (result) => {
        if (result) onText(result.getText());
      }),
  };
}
