import zlib from 'node:zlib';

// Generates PNGs with no image dependencies, so the testbed can serve real
// creative assets from its own public URL. Meta fetches ad images over HTTP, so
// pointing link_data.picture at our own domain avoids both a binary upload and
// a dependency on some third-party placeholder service staying up.

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// A blocky diagonal-gradient tile. Distinct enough per seed that the four ads
// are visually telling apart in Ads Manager.
export function makePng({ width = 1080, height = 1080, seed = 0 } = {}) {
  const palettes = [
    [[37, 211, 102], [12, 92, 52]],    // whatsapp green
    [[225, 48, 108], [92, 16, 64]],    // instagram pink
    [[24, 119, 242], [10, 46, 102]],   // facebook blue
    [[168, 85, 247], [62, 26, 102]],   // ads purple
    [[245, 181, 68], [110, 74, 12]],   // amber
  ];
  const [from, to] = palettes[seed % palettes.length];

  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      // Quantise into bands so the image reads as designed rather than muddy.
      const band = Math.round(t * 6) / 6;
      const border = x < 28 || y < 28 || x > width - 29 || y > height - 29;
      for (let c = 0; c < 3; c++) {
        raw[p++] = border ? 255 : Math.round(from[c] + (to[c] - from[c]) * band);
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
