// A stand-in damage photo for service tests: JPEG magic bytes and filler (the server checks the file
// type and size; the barcode is read in the browser, so tests pass the code "read" from the photo).

const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7), Buffer.from([0xff, 0xd9])]);

const FAKE_JPEG_URL = `data:image/jpeg;base64,${FAKE_JPEG.toString("base64")}`;

/** Photo fields of a damage report: a barcode photo showing `code` and one photo of the damage. */
export const photoOf = (code: string) => ({ photo: FAKE_JPEG_URL, photoCode: code, damagePhotos: [FAKE_JPEG_URL] });
