"use strict";

// Extracts every available item / build-element icon from spacehaven.jar into
// public/icons/.
//
// Two namespaces are extracted:
//   * Products (storage items + crops): <Product><product eid=...><GUIAnimation
//     aid="..."/></product>. Saved as <eid>.png; indexed under key "<eid>".
//     These are what storage_observations.elementary_id references.
//   * Build elements (placeable structures, dispensers, etc.): <Element><me
//     mid=...><objectInfo><guiIcon aid="..."/></objectInfo></me>. Saved as
//     mid_<mid>.png; indexed under key "mid:<mid>". Used by the map / build
//     panel.
//
// Resolution pipeline (same for both):
//   aid (string)   library/animations <ba n=...><assetPos a=...> → asset id
//   asset id (N)   library/textures   <re n="N" t="T" x y w h/>   → region in
//                                                                   atlas T
//   library/<T>.cim   zlib-deflated. Header: BE uint32 width, BE uint32
//                     height, BE uint32 channels(=4). Then RGBA8 pixels.
//
// Idempotent: if the jar mtime stored in public/icons/.jar-mtime matches the
// current jar's mtime and index.json exists, skip everything.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const { findJar } = require("./import-library");

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

// Parse haven for every <product eid=...> that carries a <GUIAnimation aid>.
// These are inventory items (Elementary type) and crops (Crop type) — the
// things storage_observations references by elementary_id.
function findProducts(havenXml) {
  const out = [];
  const re = /<product eid="(\d+)" type="(\w+)"[\s\S]*?<\/product>/g;
  let m;
  while ((m = re.exec(havenXml)) !== null) {
    const eid = Number(m[1]);
    const type = m[2];
    const aidM = /<GUIAnimation aid="([^"]+)"/.exec(m[0]);
    if (!aidM) continue;
    if (aidM[1] === "null") continue;
    out.push({ kind: "product", eid, type, aid: aidM[1] });
  }
  return out;
}

// Parse haven for every <me mid=...> whose <objectInfo> has a <guiIcon aid>.
// These are buildable map elements (machines, dispensers, decor) — what the
// build menu lists.
function findBuildElements(havenXml) {
  const out = [];
  const re = /<me mid="(\d+)"[\s\S]*?<\/me>/g;
  let m;
  while ((m = re.exec(havenXml)) !== null) {
    const mid = Number(m[1]);
    // The <guiIcon> only appears inside <objectInfo>; <me> without an
    // <objectInfo> doesn't have one. (The regex match is bounded by </me> so
    // we won't pick up a neighbouring me's guiIcon.)
    const aidM = /<guiIcon aid="([^"]+)"/.exec(m[0]);
    if (!aidM) continue;
    if (aidM[1] === "null") continue;
    out.push({ kind: "me", mid, aid: aidM[1] });
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

    const products = findProducts(haven);
    const buildEls = findBuildElements(haven);
    const aidIdx = buildAidToAssetIndex(anims);
    const regionIdx = buildAssetToRegionIndex(tex);

    logger.log(`[extract-icons] candidates: ${products.length} products + ${buildEls.length} build elements, ${aidIdx.size} aid→asset, ${regionIdx.size} regions`);

    // Resolve each candidate to a region, grouping by atlas so each CIM is
    // decoded once.
    const byAtlas = new Map(); // atlas index -> [{key, fileName, region, aid}]
    const missing = [];

    function plan(candidate) {
      const key = candidate.kind === "product" ? String(candidate.eid) : `mid:${candidate.mid}`;
      const fileName = candidate.kind === "product" ? `${candidate.eid}.png` : `mid_${candidate.mid}.png`;
      const asset = aidIdx.get(candidate.aid);
      if (asset == null) {
        missing.push({ ...candidate, reason: "no asset for aid" });
        return;
      }
      const region = regionIdx.get(asset);
      if (!region) {
        missing.push({ ...candidate, asset, reason: "no region for asset" });
        return;
      }
      if (!byAtlas.has(region.t)) byAtlas.set(region.t, []);
      byAtlas.get(region.t).push({ key, fileName, region, aid: candidate.aid });
    }
    for (const p of products) plan(p);
    for (const m of buildEls) plan(m);

    const written = [];
    const index = {}; // key (eid or "mid:N") -> { aid, w, h, atlas, file }
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
          logger.warn(`[extract-icons]   ${it.key} region OOB; skipping`);
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
        const outFile = path.join(outDir, it.fileName);
        fs.writeFileSync(outFile, png);
        written.push(outFile);
        index[it.key] = { aid: it.aid, w, h, atlas: atlasId, file: it.fileName };
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
