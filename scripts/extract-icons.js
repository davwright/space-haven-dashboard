"use strict";

// Extracts food / crop icons from spacehaven.jar into public/icons/<element_id>.png.
//
// The jar ships three artefacts we need:
//   library/haven         each <product eid=...><GUIAnimation aid="..."/></product>
//                         pairs an in-game element id with a named animation.
//   library/animations    each <ba n="aid" id="..."><items><assetPos a="N"/></items></ba>
//                         resolves the animation name to a numeric asset id.
//   library/textures      <re n="N" t="T" x y w h id="..."/> maps that asset id to
//                         a region (rect) inside atlas library/T.cim.
//   library/T.cim         zlib-deflated. Header: BE uint32 width, BE uint32 height,
//                         BE uint32 channels(=4), 4 bytes unknown (=0). Then RGBA8.
//
// We only extract icons for the elements we care about — every product whose
// type is Crop OR whose aid contains a food-suggestive substring (foodIcon,
// veggies, fruit, meat, fiber, nut, grain, algae). About a dozen PNGs total.
//
// Idempotent: if every target PNG already exists and the jar mtime stored in
// public/icons/.jar-mtime matches the current jar's mtime, skip everything.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const { findJar } = require("./import-library");

const FOOD_AID_RE = /food|veggies|veggie|fruit|meat|fiber|nut|grain|algae|hops|seed/i;

// -------- Minimal zip reader (mirrors import-library.js) -------------------

function readZipIndex(jarPath) {
  const fd = fs.openSync(jarPath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const scan = Math.min(fileSize, 22 + 65535);
    const buf = Buffer.alloc(scan);
    fs.readSync(fd, buf, 0, scan, fileSize - scan);
    let eocd = null;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = {
          cdEntries: buf.readUInt16LE(i + 10),
          cdSize: buf.readUInt32LE(i + 12),
          cdOffset: buf.readUInt32LE(i + 16),
        };
        break;
      }
    }
    if (!eocd) throw new Error("zip EOCD not found");
    const cd = Buffer.alloc(eocd.cdSize);
    fs.readSync(fd, cd, 0, eocd.cdSize, eocd.cdOffset);
    let p = 0;
    const entries = [];
    for (let i = 0; i < eocd.cdEntries; i++) {
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.slice(p + 46, p + 46 + nameLen).toString("utf8");
      entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { fd, entries };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

function readEntry(fd, entry) {
  const lfh = Buffer.alloc(30);
  fs.readSync(fd, lfh, 0, 30, entry.localHeaderOffset);
  const nameLen = lfh.readUInt16LE(26);
  const extraLen = lfh.readUInt16LE(28);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const compressed = Buffer.alloc(entry.compressedSize);
  fs.readSync(fd, compressed, 0, entry.compressedSize, dataStart);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

// -------- CIM atlas decoder -----------------------------------------------
//
// Header (12 bytes BE): width, height, channels(=4). Then width*height*4 RGBA8.
// (There are sometimes 4 trailing bytes after the pixel data; ignore them.)

function decodeCim(buf) {
  const inflated = zlib.inflateSync(buf);
  const width = inflated.readUInt32BE(0);
  const height = inflated.readUInt32BE(4);
  const channels = inflated.readUInt32BE(8);
  if (channels !== 4) throw new Error(`unexpected channel count ${channels}`);
  const expected = width * height * 4;
  const pixels = inflated.slice(12, 12 + expected);
  if (pixels.length !== expected) {
    throw new Error(`pixel buffer short: ${pixels.length} vs ${expected}`);
  }
  return { width, height, pixels };
}

// -------- Tiny PNG encoder ------------------------------------------------

function crc32(buf) {
  let c;
  const t = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildPng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter "None"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// -------- Driver ----------------------------------------------------------

// Parse haven for { eid, aid } pairs we care about. We DON'T pull in a full
// XML parser for this — the pattern is regular enough to grep, and we only
// need products that mention type=Crop or have a food-shaped aid.
function findFoodProducts(havenXml) {
  const out = [];
  const re = /<product eid="(\d+)" type="(\w+)"[\s\S]*?<\/product>/g;
  let m;
  while ((m = re.exec(havenXml)) !== null) {
    const eid = Number(m[1]);
    const type = m[2];
    const inner = m[0];
    const aidM = /<GUIAnimation aid="([^"]+)"/.exec(inner);
    if (!aidM) continue;
    const aid = aidM[1];
    if (type === "Crop" || FOOD_AID_RE.test(aid)) {
      out.push({ eid, type, aid });
    }
  }
  return out;
}

function buildAidToAssetIndex(animsXml) {
  // <ba n="..."> ... <items><assetPos ... a="N"/></items></ba>
  // We only need the first assetPos of each <ba> (these icon animations have
  // a single static sprite, not a multi-frame timeline).
  const out = new Map();
  const re = /<ba n="([^"]+)"[\s\S]*?<assetPos[^>]*a="(\d+)"/g;
  let m;
  while ((m = re.exec(animsXml)) !== null) {
    if (!out.has(m[1])) out.set(m[1], Number(m[2]));
  }
  return out;
}

function buildAssetToRegionIndex(texturesXml) {
  // <re n="N" t="T" x="..." y="..." w="..." h="..." id="..."/>
  const out = new Map();
  const re = /<re n="(\d+)" t="(\d+)" x="(\d+)" y="(\d+)" w="(\d+)" h="(\d+)"/g;
  let m;
  while ((m = re.exec(texturesXml)) !== null) {
    out.set(Number(m[1]), {
      t: Number(m[2]),
      x: Number(m[3]),
      y: Number(m[4]),
      w: Number(m[5]),
      h: Number(m[6]),
    });
  }
  return out;
}

function extractIcons({ jarPath, outDir, logger = console } = {}) {
  jarPath = jarPath || findJar();
  if (!jarPath || !fs.existsSync(jarPath)) {
    throw new Error("spacehaven.jar not found (set SPACE_HAVEN_JAR_PATH)");
  }
  outDir = outDir || path.join(__dirname, "..", "public", "icons");
  fs.mkdirSync(outDir, { recursive: true });

  const jarMtime = Math.floor(fs.statSync(jarPath).mtimeMs);
  const stampFile = path.join(outDir, ".jar-mtime");
  const indexFile = path.join(outDir, "index.json");
  const stamped = fs.existsSync(stampFile) ? Number(fs.readFileSync(stampFile, "utf8").trim()) : null;
  const haveIndex = fs.existsSync(indexFile);
  if (stamped === jarMtime && haveIndex) {
    logger.log(`[extract-icons] up to date (jar mtime ${jarMtime}); skipping`);
    return { skipped: true, jarPath, outDir };
  }

  logger.log(`[extract-icons] reading ${jarPath}`);
  const zip = readZipIndex(jarPath);
  try {
    const haven = readEntry(zip.fd, zip.entries.find((e) => e.name === "library/haven")).toString("utf8");
    const anims = readEntry(zip.fd, zip.entries.find((e) => e.name === "library/animations")).toString("utf8");
    const tex = readEntry(zip.fd, zip.entries.find((e) => e.name === "library/textures")).toString("utf8");

    const products = findFoodProducts(haven);
    const aidIdx = buildAidToAssetIndex(anims);
    const regionIdx = buildAssetToRegionIndex(tex);

    logger.log(`[extract-icons] candidates: ${products.length} products, ${aidIdx.size} aid→asset, ${regionIdx.size} regions`);

    // Resolve each product to a region, grouping by atlas to avoid decoding the
    // same big CIM twice.
    const byAtlas = new Map(); // atlas index -> [{eid, region, aid}]
    const resolved = [];
    const missing = [];
    for (const p of products) {
      const asset = aidIdx.get(p.aid);
      if (asset == null) {
        missing.push({ ...p, reason: "no asset for aid" });
        continue;
      }
      const region = regionIdx.get(asset);
      if (!region) {
        missing.push({ ...p, asset, reason: "no region for asset" });
        continue;
      }
      resolved.push({ ...p, asset, region });
      if (!byAtlas.has(region.t)) byAtlas.set(region.t, []);
      byAtlas.get(region.t).push({ eid: p.eid, region, aid: p.aid });
    }

    const written = [];
    const index = {}; // eid -> { aid, w, h, atlas }
    for (const [atlasId, items] of byAtlas) {
      const cimEntry = zip.entries.find((e) => e.name === `library/${atlasId}.cim`);
      if (!cimEntry) {
        logger.warn(`[extract-icons] missing atlas library/${atlasId}.cim — skipping ${items.length} items`);
        continue;
      }
      const cimBuf = readEntry(zip.fd, cimEntry);
      const atlas = decodeCim(cimBuf);
      logger.log(`[extract-icons] atlas ${atlasId}: ${atlas.width}x${atlas.height}, ${items.length} icons`);
      for (const it of items) {
        const { x, y, w, h } = it.region;
        if (x + w > atlas.width || y + h > atlas.height) {
          logger.warn(`[extract-icons]   eid=${it.eid} region OOB; skipping`);
          continue;
        }
        const region = Buffer.alloc(w * h * 4);
        for (let dy = 0; dy < h; dy++) {
          atlas.pixels.copy(
            region,
            dy * w * 4,
            ((y + dy) * atlas.width + x) * 4,
            ((y + dy) * atlas.width + x + w) * 4
          );
        }
        const png = buildPng(w, h, region);
        const outFile = path.join(outDir, `${it.eid}.png`);
        fs.writeFileSync(outFile, png);
        written.push(outFile);
        index[String(it.eid)] = { aid: it.aid, w, h, atlas: atlasId };
      }
    }

    fs.writeFileSync(stampFile, String(jarMtime));
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    logger.log(`[extract-icons] wrote ${written.length} icons to ${outDir}; ${missing.length} unresolved`);
    return { skipped: false, jarPath, outDir, written, missing, jarMtime };
  } finally {
    fs.closeSync(zip.fd);
  }
}

function main() {
  try {
    extractIcons();
  } catch (err) {
    console.error("[extract-icons]", err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { extractIcons };
