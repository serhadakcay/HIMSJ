/**
 * Yardımcı Modüller:
 * 1. Yerel Ağ (LAN) IP tespiti (Telefon bağlantısı için)
 * 2. Otomatik X.509 Self-Signed TLS/HTTPS Sertifika Üretici (Harici OpenSSL gerektirmez)
 * 3. Standart ISO/IEC 18004 SVG QR Kod Üretici (Telefon kamerasıyla okutmak için)
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({
          name,
          address: iface.address,
          isPrivate:
            iface.address.startsWith('192.168.') ||
            iface.address.startsWith('10.') ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(iface.address)
        });
      }
    }
  }
  ips.sort((a, b) => Number(b.isPrivate) - Number(a.isPrivate));
  return ips;
}

// --- ASN.1 DER Yardımcıları (X.509 Sertifika Üretimi İçin) ---
function derLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let tmp = len;
  while (tmp > 0) {
    bytes.unshift(tmp & 0xff);
    tmp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derNode(tag, contentBuf) {
  return Buffer.concat([Buffer.from([tag]), derLength(contentBuf.length), contentBuf]);
}

function derSeq(...items) {
  return derNode(0x30, Buffer.concat(items));
}

function derSet(...items) {
  return derNode(0x31, Buffer.concat(items));
}

function derOid(oidBytes) {
  return derNode(0x06, Buffer.from(oidBytes));
}

function derUtf8(str) {
  return derNode(0x0c, Buffer.from(str, 'utf8'));
}

function derUtcTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yy = pad(date.getUTCFullYear() % 100);
  const MM = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return derNode(0x17, Buffer.from(`${yy}${MM}${dd}${hh}${mm}${ss}Z`, 'ascii'));
}

function derInteger(buf) {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
  if (b[0] & 0x80) {
    b = Buffer.concat([Buffer.from([0x00]), b]);
  }
  return derNode(0x02, b);
}

function derBitString(buf) {
  return derNode(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function ensureTlsCertificate(certDir) {
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }
  const certPath = path.join(certDir, 'cert.pem');
  const keyPath = path.join(certDir, 'key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      return {
        cert: fs.readFileSync(certPath, 'utf8'),
        key: fs.readFileSync(keyPath, 'utf8')
      };
    } catch {
      // Yeniden üret
    }
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  });

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  // sha256WithRSAEncryption OID: 1.2.840.113549.1.1.11
  const algId = derSeq(
    derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
    Buffer.from([0x05, 0x00])
  );

  // CN = MesajlasmaLocalServer (OID 2.5.4.3 -> 55 04 03)
  const name = derSeq(
    derSet(
      derSeq(
        derOid([0x55, 0x04, 0x03]),
        derUtf8('MesajlasmaLocalServer')
      )
    )
  );

  const now = new Date(Date.now() - 86400000);
  const exp = new Date(Date.now() + 3650 * 86400000);
  const validity = derSeq(derUtcTime(now), derUtcTime(exp));

  const version = derNode(0xa0, derInteger(2)); // v3
  const serial = derInteger(crypto.randomBytes(8));

  const tbs = derSeq(
    version,
    serial,
    algId,
    name,
    validity,
    name,
    spkiDer
  );

  const signer = crypto.createSign('SHA256');
  signer.update(tbs);
  const signature = signer.sign(privateKey);

  const certDer = derSeq(tbs, algId, derBitString(signature));
  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;

  fs.writeFileSync(certPath, certPem, 'utf8');
  fs.writeFileSync(keyPath, keyPem, 'utf8');

  return { cert: certPem, key: keyPem };
}

// --- Saf JS ISO/IEC 18004 QR Kod Üretici (Byte Modu, ECC Level L, Versiyon 1..6) ---
const QR_VERSIONS = [
  null,
  { size: 21, totalCodewords: 26, ecCodewords: 7, dataCodewords: 19, align: [] },
  { size: 25, totalCodewords: 44, ecCodewords: 10, dataCodewords: 34, align: [6, 18] },
  { size: 29, totalCodewords: 70, ecCodewords: 15, dataCodewords: 55, align: [6, 22] },
  { size: 33, totalCodewords: 100, ecCodewords: 20, dataCodewords: 80, align: [6, 26] },
  { size: 37, totalCodewords: 134, ecCodewords: 26, dataCodewords: 108, align: [6, 30] },
  { size: 41, totalCodewords: 172, ecCodewords: 36, dataCodewords: 136, align: [6, 34] }
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const msg = new Uint8Array(data.length + ecLen);
  msg.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

function encodeQrMatrix(text) {
  const utf8 = Buffer.from(String(text), 'utf8');
  let ver = 1;
  while (ver <= 6 && utf8.length + 2 > QR_VERSIONS[ver].dataCodewords) {
    ver++;
  }
  if (ver > 6) ver = 6;
  const info = QR_VERSIONS[ver];
  const bytes = utf8.slice(0, info.dataCodewords - 2);

  // Bit akışı: 0100 (Byte mode) + 8-bit length + bytes + terminator
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = info.dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataWords = new Uint8Array(info.dataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    dataWords[i] = b;
  }
  const padBytes = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < info.dataCodewords; i++, p++) {
    dataWords[i] = padBytes[p % 2];
  }

  let allCodewords;
  if (ver === 6) {
    // Versiyon 6-L: 2 blok (her biri 68 data + 18 EC)
    const b1 = dataWords.slice(0, 68);
    const b2 = dataWords.slice(68, 136);
    const ec1 = rsEncode(b1, 18);
    const ec2 = rsEncode(b2, 18);
    allCodewords = [];
    for (let i = 0; i < 68; i++) allCodewords.push(b1[i], b2[i]);
    for (let i = 0; i < 18; i++) allCodewords.push(ec1[i], ec2[i]);
  } else {
    const ec = rsEncode(dataWords, info.ecCodewords);
    allCodewords = [...dataWords, ...ec];
  }

  const size = info.size;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setModule = (r, c, val, isFunc = true) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    matrix[r][c] = val ? 1 : 0;
    if (isFunc) reserved[r][c] = true;
  };

  const drawFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const inBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setModule(r, c, inOuter && (inBorder || inInner), true);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0, true);
    setModule(i, 6, i % 2 === 0, true);
  }

  // Alignment pattern
  if (info.align.length > 0) {
    const [a0, a1] = info.align;
    const coords = [
      [a0, a0],
      [a0, a1],
      [a1, a0],
      [a1, a1]
    ];
    for (const [cr, cc] of coords) {
      if (reserved[cr][cc]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setModule(cr + dr, cc + dc, isDark, true);
        }
      }
    }
  }

  // Dark module & format reserve
  setModule(size - 8, 8, 1, true);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) setModule(8, i, 0, true);
    if (!reserved[i][8]) setModule(i, 8, 0, true);
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) setModule(8, size - 1 - i, 0, true);
    if (!reserved[size - 1 - i][8]) setModule(size - 1 - i, 8, 0, true);
  }

  // Veri bitlerini yerleştir
  const dataBits = [];
  for (const cw of allCodewords) {
    for (let i = 7; i >= 0; i--) dataBits.push((cw >> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (!reserved[row][c]) {
          const bit = bitIdx < dataBits.length ? dataBits[bitIdx++] : 0;
          // Mask 0: (row + c) % 2 === 0
          const masked = ((row + c) % 2 === 0) ? (bit ^ 1) : bit;
          matrix[row][c] = masked;
        }
      }
    }
    upward = !upward;
  }

  // Format bilgisi (ECC Level L = 01, Mask 0 = 000 -> 0x77c4)
  const formatBits = 0x77c4;
  const fCoords1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  for (let i = 0; i < 15; i++) {
    const bit = (formatBits >> i) & 1;
    const [r, c] = fCoords1[i];
    matrix[r][c] = bit;
    if (i < 7) {
      matrix[size - 1 - i][8] = bit;
    } else {
      matrix[8][size - 15 + i] = bit;
    }
  }

  return matrix;
}

function generateQrSvg(text, pixelSize = 240) {
  const matrix = encodeQrMatrix(text);
  const quiet = 3;
  const total = matrix.length + quiet * 2;
  let paths = '';
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r][c]) {
        paths += `M${c + quiet},${r + quiet}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges">
    <rect width="100%" height="100%" fill="#ffffff" rx="2"/>
    <path d="${paths}" fill="#0f172a"/>
  </svg>`;
}

module.exports = {
  getLocalIPs,
  ensureTlsCertificate,
  generateQrSvg
};
