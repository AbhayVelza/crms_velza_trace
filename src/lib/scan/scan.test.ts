// Scanner building blocks: input normalisation, the one-at-a-time gate, the live checklist and the camera session
// (with a mocked camera: no real device is involved here).

import { describe, expect, it } from "vitest";
import { activeCameraSession, CAMERA_SIZE, CameraSession, toCameraError, type CameraEnv, type Decoder, type VideoLike } from "./camera";
import { applyAccepted, applyRejected, countChecklist, createChecklist, filterRows, mergeExpected, nextPending, pageOf, rebaseChecklist, resetAll, resetItem, statusForRejection } from "./checklist";
import { ScanGate } from "./gate";
import { checkCodeFormat, normalizeScannedCode } from "./normalize";

const LOT = "91BMMU03OR00001";
const PACK = "91BMMU03OR0000161";

describe("normalizeScannedCode / checkCodeFormat", () => {
  it("keeps valid codes exactly, including leading zeros and hex digits", () => {
    expect(normalizeScannedCode("91BMMU03OR00001")).toBe("91BMMU03OR00001");
    expect(normalizeScannedCode("91BMMU03OR0000A")).toBe("91BMMU03OR0000A");
    expect(normalizeScannedCode("0091")).toBe("0091");
  });
  it("strips scanner prefixes/suffixes (Tab, GS, CR/LF, BOM) and spaces", () => {
    expect(normalizeScannedCode(`\t${LOT}\r\n`)).toBe(LOT);
    expect(normalizeScannedCode(`\u001d${PACK}\u0004`)).toBe(PACK);
    expect(normalizeScannedCode(`﻿  ${LOT}  `)).toBe(LOT);
  });
  it("upper-cases a code typed or sent in lower case", () => {
    expect(normalizeScannedCode("91bmmu03or00001")).toBe(LOT);
  });
  it("takes the code out of a lot QR URL", () => {
    expect(normalizeScannedCode(`https://velza.example/t/${LOT}`)).toBe(LOT);
    expect(normalizeScannedCode(`https://velza.example/t/${LOT}?src=qr`)).toBe(LOT);
  });
  it("distinguishes 15-character lot codes from 17-character pack codes", () => {
    expect(checkCodeFormat(LOT)).toEqual({ ok: true, code: LOT, kind: "LOT" });
    expect(checkCodeFormat(PACK)).toEqual({ ok: true, code: PACK, kind: "PACK" });
    expect(checkCodeFormat("91BMMU03OR000016")).toMatchObject({ ok: false, message: expect.stringMatching(/15 characters, a pack code 17 \(this one has 16\)/) });
  });
  it("refuses partial input, empty input and impossible pack numbers", () => {
    expect(checkCodeFormat("91BMMU")).toMatchObject({ ok: false });
    expect(checkCodeFormat("   ")).toMatchObject({ ok: false, message: "Scan or type a code first" });
    expect(checkCodeFormat("91BMMU03OR0000169")).toMatchObject({ ok: false, message: expect.stringMatching(/Pack sequence/) });
  });
});

describe("ScanGate", () => {
  it("lets only one scan through until the server has answered", () => {
    const g = new ScanGate();
    expect(g.begin(LOT, "keyboard")).toEqual({ ok: true });
    expect(g.begin(LOT, "keyboard")).toEqual({ ok: false, reason: "BUSY" }); // double Enter
    expect(g.begin(PACK, "manual")).toEqual({ ok: false, reason: "BUSY" });
    g.end();
    expect(g.begin(PACK, "manual")).toEqual({ ok: true });
  });
  it("ignores the same camera code while the sticker stays in view, but accepts it again after a pause", () => {
    const g = new ScanGate(2500);
    expect(g.begin(LOT, "camera", 0)).toEqual({ ok: true });
    g.end();
    for (let t = 100; t < 5000; t += 100) expect(g.begin(LOT, "camera", t)).toEqual({ ok: false, reason: "REPEAT_FRAME" });
    expect(g.begin(LOT, "camera", 5000 + 2500)).toEqual({ ok: true });
  });
  it("a different camera code is accepted at once; repeat suppression does not apply to the keyboard", () => {
    const g = new ScanGate();
    expect(g.begin(LOT, "camera", 0).ok).toBe(true);
    g.end();
    expect(g.begin(PACK, "camera", 10).ok).toBe(true);
    g.end();
    expect(g.begin(PACK, "keyboard", 20).ok).toBe(true); // a deliberate re-scan reaches the server (which reports DUPLICATE)
  });
});

describe("checklist", () => {
  const items = [LOT, `${LOT}61`, `${LOT}62`, `${LOT}63`, `${LOT}64`].map((code) => ({ code, kind: (code.length === 15 ? "LOT" : "PACK") as "LOT" | "PACK" }));

  it("starts with every expected code PENDING, one row per code, in order", () => {
    const s = createChecklist([...items, items[1]]);
    expect(s.rows.map((r) => [r.code, r.status])).toEqual(items.map((i) => [i.code, "PENDING"]));
    expect(countChecklist(s)).toEqual({ expected: 5, scanned: 0, pending: 5, rejected: 0, percent: 0, complete: false });
  });

  it("an accepted scan changes only its own row; counts and percent follow", () => {
    let s = createChecklist(items);
    s = applyAccepted(s, `${LOT}62`);
    expect(s.rows.map((r) => r.status)).toEqual(["PENDING", "PENDING", "SCANNED", "PENDING", "PENDING"]);
    s = applyAccepted(s, LOT);
    s = applyAccepted(s, `${LOT}61`);
    expect(countChecklist(s)).toMatchObject({ scanned: 3, pending: 2, percent: 60, complete: false });
    expect(nextPending(s)).toBe(3);
  });

  it("a refused scan never counts as scanned; a refused code not on the list is kept aside", () => {
    let s = createChecklist(items);
    s = applyRejected(s, `${LOT}63`, "BLOCKED_CODE", "Lot is QUARANTINED");
    s = applyRejected(s, "91XXXXXXOR0000161", "WRONG_LOT", "does not belong");
    expect(s.rows[3]).toMatchObject({ status: "BLOCKED", message: "Lot is QUARANTINED" });
    expect(s.strays).toEqual([{ code: "91XXXXXXOR0000161", status: "INVALID", message: "does not belong" }]);
    expect(countChecklist(s)).toMatchObject({ scanned: 0, pending: 5, rejected: 2 });
  });

  it("a duplicate scan keeps the original success", () => {
    let s = createChecklist(items);
    s = applyAccepted(s, `${LOT}61`, "OK");
    s = applyRejected(s, `${LOT}61`, "DUPLICATE_SCAN", "already scanned");
    expect(s.rows[1]).toMatchObject({ status: "SCANNED", message: "OK" });
    expect(countChecklist(s).scanned).toBe(1);
  });

  it("maps server result codes to statuses", () => {
    expect(statusForRejection("DUPLICATE_RECEIPT")).toBe("DUPLICATE");
    expect(statusForRejection("DUPLICATE_SCAN")).toBe("DUPLICATE");
    for (const c of ["BLOCKED_CODE", "NOT_PRINTED", "WRONG_RECEIVER", "WRONG_STATUS", "UNSYNCED"]) expect(statusForRejection(c)).toBe("BLOCKED");
    for (const c of ["UNKNOWN_CODE", "INVALID_CODE", "WRONG_LOT", undefined]) expect(statusForRejection(c)).toBe("INVALID");
  });

  it("is complete only when every expected code is scanned", () => {
    let s = createChecklist(items);
    for (const i of items.slice(0, 4)) s = applyAccepted(s, i.code);
    expect(countChecklist(s)).toMatchObject({ complete: false, pending: 1, percent: 80 });
    s = applyAccepted(s, items[4].code);
    expect(countChecklist(s)).toMatchObject({ complete: true, pending: 0, percent: 100 });
    s = resetItem(s, items[0].code);
    expect(countChecklist(s).complete).toBe(false);
    s = resetAll(applyRejected(s, "91XXXXXXOR00001", "UNKNOWN_CODE", "x"));
    expect(countChecklist(s)).toMatchObject({ expected: 5, scanned: 0, rejected: 0 });
    expect(countChecklist(createChecklist([])).complete).toBe(false);
  });

  it("filters (all / scanned / pending / invalid) and search keep the stable order", () => {
    let s = createChecklist(items.map((i, n) => ({ ...i, group: n < 3 ? "INV-1" : "INV-2" })));
    s = applyAccepted(s, `${LOT}64`);
    s = applyAccepted(s, LOT);
    s = applyRejected(s, `${LOT}62`, "UNKNOWN_CODE", "x");
    const codes = (f: Parameters<typeof filterRows>[1], q = "") => filterRows(s, f, q).map((r) => r.code);
    expect(codes("ALL")).toEqual(items.map((i) => i.code));
    expect(codes("SCANNED")).toEqual([LOT, `${LOT}64`]);
    expect(codes("PENDING")).toEqual([`${LOT}61`, `${LOT}62`, `${LOT}63`]);
    expect(codes("INVALID")).toEqual([`${LOT}62`]);
    expect(codes("ALL", "63")).toEqual([`${LOT}63`]);
    expect(codes("ALL", "inv-2")).toEqual([`${LOT}63`, `${LOT}64`]);
  });

  it("new expected codes are appended without disturbing existing rows", () => {
    let s = applyAccepted(createChecklist(items.slice(0, 2)), LOT);
    s = mergeExpected(s, items);
    expect(s.rows.map((r) => r.code)).toEqual(items.map((i) => i.code));
    expect(s.rows[0].status).toBe("SCANNED");
  });

  it("a reloaded server list keeps this session's statuses; items that left are dropped unless kept", () => {
    let s = createChecklist(items.slice(0, 3));
    s = applyAccepted(s, items[0].code);
    s = applyRejected(s, items[1].code, "BLOCKED_CODE", "quarantined");
    const reloaded = rebaseChecklist(s, [items[1], items[2], items[3]]); // items[0] left (e.g. received), items[3] arrived
    expect(reloaded.rows.map((r) => [r.code, r.status])).toEqual([[items[1].code, "BLOCKED"], [items[2].code, "PENDING"], [items[3].code, "PENDING"]]);
    const kept = rebaseChecklist(s, [items[1], items[2]], (r) => r.status === "SCANNED");
    expect(kept.rows.map((r) => [r.code, r.status])).toEqual([[items[1].code, "BLOCKED"], [items[2].code, "PENDING"], [items[0].code, "SCANNED"]]);
    expect(kept.index.get(items[0].code)).toBe(2);
  });

  it("pages large lists and handles 10,000 rows quickly", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({ code: `91BMMU03OR${(i + 1).toString(16).toUpperCase().padStart(5, "0")}`, kind: "LOT" as const }));
    const t0 = performance.now();
    let s = createChecklist(many);
    for (let i = 0; i < 1000; i++) s = applyAccepted(s, many[i * 10].code);
    const page = pageOf(filterRows(s, "PENDING", ""), 3, 50);
    const ms = performance.now() - t0;
    expect(countChecklist(s)).toMatchObject({ expected: 10_000, scanned: 1000, percent: 10 });
    expect(page).toMatchObject({ page: 3, pages: 180 });
    expect(page.rows).toHaveLength(50);
    expect(ms).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------- camera (mocked)

function fakeTrack(torch = false) {
  const t = {
    readyState: "live" as "live" | "ended",
    stop() {
      t.readyState = "ended";
    },
    getCapabilities: () => (torch ? { torch: true } : {}),
    applied: [] as unknown[],
    async applyConstraints(c: unknown) {
      t.applied.push(c);
    },
  };
  return t;
}
function fakeEnv(opts: { secure?: boolean; error?: string; torch?: boolean; noDevices?: boolean } = {}) {
  const tracks: ReturnType<typeof fakeTrack>[] = [];
  const calls: MediaStreamConstraints[] = [];
  const env: CameraEnv = {
    isSecureContext: opts.secure ?? true,
    mediaDevices: opts.noDevices
      ? undefined
      : {
          async getUserMedia(c?: MediaStreamConstraints) {
            calls.push(c!);
            if (opts.error) throw Object.assign(new Error(opts.error), { name: opts.error });
            const t = fakeTrack(opts.torch);
            tracks.push(t);
            return { getTracks: () => [t], getVideoTracks: () => [t] } as unknown as MediaStream;
          },
          async enumerateDevices() {
            return [
              { kind: "videoinput", deviceId: "rear", label: "Back camera" },
              { kind: "audioinput", deviceId: "mic", label: "Mic" },
              { kind: "videoinput", deviceId: "front", label: "" },
            ] as MediaDeviceInfo[];
          },
        },
  };
  return { env, tracks, calls };
}
function fakeDecoder(env: CameraEnv) {
  const d = { emit: (() => {}) as (text: string) => void, stops: 0 };
  const decoder: Decoder = {
    async start(constraints, video, onText) {
      video.srcObject = await env.mediaDevices!.getUserMedia(constraints);
      d.emit = onText;
      return { stop: () => void d.stops++ };
    },
  };
  return { decoder, d };
}
const video = (): VideoLike => ({ srcObject: null });

describe("CameraSession (mocked camera)", () => {
  it("starts on the rear camera, passes decoded codes on, and releases every track on stop", async () => {
    const { env, tracks, calls } = fakeEnv();
    const { decoder, d } = fakeDecoder(env);
    const seen: string[] = [];
    const v = video();
    const s = new CameraSession(v, decoder, env, (t) => seen.push(t));
    await s.start();
    expect(calls[0]).toEqual({ audio: false, video: { facingMode: { ideal: "environment" }, ...CAMERA_SIZE } });
    expect(s.state).toBe("running");
    d.emit(LOT);
    expect(seen).toEqual([LOT]);
    s.stop();
    expect(tracks[0].readyState).toBe("ended");
    expect(v.srcObject).toBeNull();
    expect(d.stops).toBe(1);
    d.emit(PACK); // a late frame after stop is dropped
    expect(seen).toEqual([LOT]);
    s.stop(); // idempotent
  });

  it("switching camera stops the old stream first; only one session holds the camera", async () => {
    const { env, tracks, calls } = fakeEnv();
    const { decoder } = fakeDecoder(env);
    const a = new CameraSession(video(), decoder, env, () => {});
    await a.start();
    await a.start("front");
    expect(calls[1]).toEqual({ audio: false, video: { deviceId: { exact: "front" }, ...CAMERA_SIZE } });
    expect(tracks.map((t) => t.readyState)).toEqual(["ended", "live"]);
    const b = new CameraSession(video(), decoder, env, () => {});
    await b.start();
    expect(a.state).toBe("stopped");
    expect(tracks.map((t) => t.readyState)).toEqual(["ended", "ended", "live"]);
    expect(activeCameraSession()).toBe(b);
    b.stop();
    expect(activeCameraSession()).toBeNull();
  });

  it("stop() while the camera is still opening releases it as soon as it opens (unmount during start)", async () => {
    const { env, tracks } = fakeEnv();
    const { decoder } = fakeDecoder(env);
    const s = new CameraSession(video(), decoder, env, () => {});
    const starting = s.start();
    s.stop();
    await starting;
    expect(tracks[0].readyState).toBe("ended");
    expect(s.state).toBe("stopped");
  });

  it("permission denied, no camera, camera busy, insecure page, no camera API: clear messages, nothing left running", async () => {
    for (const [error, kind, msg] of [
      ["NotAllowedError", "DENIED", /permission was refused/],
      ["NotFoundError", "NOT_FOUND", /No camera was found/],
      ["NotReadableError", "IN_USE", /busy in another app/],
    ] as const) {
      const { env } = fakeEnv({ error });
      const s = new CameraSession(video(), fakeDecoder(env).decoder, env, () => {});
      await expect(s.start()).rejects.toMatchObject({ kind, message: expect.stringMatching(msg) });
      expect(s.state).toBe("idle");
    }
    const insecure = fakeEnv({ secure: false }).env;
    await expect(new CameraSession(video(), fakeDecoder(insecure).decoder, insecure, () => {}).start()).rejects.toMatchObject({ kind: "INSECURE" });
    const none = fakeEnv({ noDevices: true }).env;
    await expect(new CameraSession(video(), fakeDecoder(none).decoder, none, () => {}).start()).rejects.toMatchObject({ kind: "UNSUPPORTED" });
    expect(toCameraError(new Error("x")).kind).toBe("FAILED");
  });

  it("torch: offered only when the camera supports it", async () => {
    const plain = fakeEnv();
    const a = new CameraSession(video(), fakeDecoder(plain.env).decoder, plain.env, () => {});
    await a.start();
    expect(a.torchSupported).toBe(false);
    expect(await a.setTorch(true)).toBe(false);
    a.stop();

    const lit = fakeEnv({ torch: true });
    const b = new CameraSession(video(), fakeDecoder(lit.env).decoder, lit.env, () => {});
    await b.start();
    expect(b.torchSupported).toBe(true);
    expect(await b.setTorch(true)).toBe(true);
    expect(b.torchOn).toBe(true);
    // The first request is the continuous-focus one made when the camera starts.
    expect(lit.tracks[0].applied).toEqual([{ advanced: [{ focusMode: "continuous" }] }, { advanced: [{ torch: true }] }]);
    b.stop();
    expect(b.torchOn).toBe(false);
  });

  it("lists video inputs only, with a readable name when the browser hides labels", async () => {
    expect(await CameraSession.listCameras(fakeEnv().env)).toEqual([
      { deviceId: "rear", label: "Back camera" },
      { deviceId: "front", label: "Camera 2" },
    ]);
    expect(await CameraSession.listCameras(fakeEnv({ noDevices: true }).env)).toEqual([]);
  });

  it("repeated frames of one sticker reach the server once (camera → gate)", async () => {
    const { env } = fakeEnv();
    const { decoder, d } = fakeDecoder(env);
    const gate = new ScanGate(2500);
    const sent: string[] = [];
    const s = new CameraSession(video(), decoder, env, (text) => {
      const code = normalizeScannedCode(text);
      if (gate.begin(code, "camera").ok) {
        sent.push(code);
        gate.end();
      }
    });
    await s.start();
    for (let i = 0; i < 30; i++) d.emit(`https://velza.example/t/${LOT}`);
    d.emit(PACK);
    for (let i = 0; i < 30; i++) d.emit(PACK);
    expect(sent).toEqual([LOT, PACK]);
    s.stop();
  });
});
