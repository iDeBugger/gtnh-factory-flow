/** The 33 bytes a PNG starts with: the signature and an IHDR chunk declaring `width` by `height`. */
export function pngHeader(width: number, height: number, tag = "IHDR"): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write(tag, 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // colour type: RGBA
  return bytes;
}
