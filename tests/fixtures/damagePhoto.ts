// A stand-in damage photo for service tests: JPEG magic bytes and filler (the server checks the file
// type and size; the barcode is read in the browser, so tests pass the code "read" from the photo).

const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7), Buffer.from([0xff, 0xd9])]);

/** Photo fields of a damage report whose photo shows `code`. */
export const photoOf = (code: string) => ({ photo: `data:image/jpeg;base64,${FAKE_JPEG.toString("base64")}`, photoCode: code });
