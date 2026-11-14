// One scan at a time, and no repeats from the camera: the camera decodes the same sticker many times a second while it
// stays in view, and a keyboard-wedge scanner can send Enter twice. The gate is synchronous (a ref, not React state),
// so two submissions in the same tick cannot both pass.

export type ScanSource = "keyboard" | "manual" | "camera" | "demo";

export type GateDecision = { ok: true } | { ok: false; reason: "BUSY" | "REPEAT_FRAME" };

export class ScanGate {
  private inFlight = false;
  private lastCamera: { code: string; at: number } | null = null;

  /** @param repeatWindowMs how long the same camera code is ignored after it was read (the sticker is still in view) */
  constructor(private readonly repeatWindowMs = 2500) {}

  /** Call before sending a code; on ok the caller must call `end()` when the server has answered. */
  begin(code: string, source: ScanSource, now = Date.now()): GateDecision {
    if (source === "camera") {
      // Same code still in front of the lens: ignore, and keep the window open while it stays there.
      if (this.lastCamera && this.lastCamera.code === code && now - this.lastCamera.at < this.repeatWindowMs) {
        this.lastCamera.at = now;
        return { ok: false, reason: "REPEAT_FRAME" };
      }
    }
    if (this.inFlight) return { ok: false, reason: "BUSY" };
    this.inFlight = true;
    if (source === "camera") this.lastCamera = { code, at: now };
    return { ok: true };
  }

  end() {
    this.inFlight = false;
  }

  get busy() {
    return this.inFlight;
  }
}
