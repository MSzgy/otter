// The phone link's encryption, the same on the local network and (later)
// through a relay. Each side has a long-lived X25519 key; pairing (a QR code
// with the Mac's public key and a one-time code) tells each the other's.
// Every connection then does one round trip:
//
//   phone → Mac  {t:"hello", v:1, kind:"pair"|"resume", k: phone key, e: phone ephemeral}
//   Mac → phone  {t:"welcome", v:1, e: Mac ephemeral}
//
// and both derive two keys from DH(e,e) ‖ DH(phone key, Mac e) ‖ DH(phone e,
// Mac key), salted with the pairing code when pairing, bound to both messages.
// Only the holders of both long-lived keys (and, for pairing, the code) get
// the same keys; ephemerals give forward secrecy. Frames after that are
// AES-256-GCM (Electron's BoringSSL has no ChaCha20-Poly1305 cipher; Apple
// chips do AES in hardware) with a per-direction counter as the nonce, so a dropped,
// reordered or replayed frame fails to open. Inside: one flag byte (1 = the
// rest is raw deflate) and UTF-8 JSON.
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s || ""), "base64url");
const INFO = Buffer.from("otter-sync v1");
const COMPRESS_OVER = 1024;

function keyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  return {
    privateKey,
    public: b64u(
      Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"),
    ),
    secret: privateKey.export({ format: "jwk" }).d,
  };
}
// A saved key: { public, secret } as base64url strings.
function loadKey({ public: pub, secret }) {
  const privateKey = crypto.createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: pub, d: secret },
    format: "jwk",
  });
  return { privateKey, public: pub, secret };
}
function publicKey(raw) {
  const bytes = unb64u(raw);
  if (bytes.length !== 32) throw new Error("bad key");
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: b64u(bytes) },
    format: "jwk",
  });
}
const dh = (privateKey, raw) =>
  crypto.diffieHellman({ privateKey, publicKey: publicKey(raw) });

// Both sides call this with their own view; the phone's keys come first.
// side: "phone" | "mac"; mine: {privateKey, public}; myEphemeral likewise;
// theirs/theirEphemeral: raw public keys; hello/welcome: the exact texts sent.
function deriveKeys({
  side,
  mine,
  myEphemeral,
  theirs,
  theirEphemeral,
  hello,
  welcome,
  code,
}) {
  const parts =
    side === "phone"
      ? [
          dh(myEphemeral.privateKey, theirEphemeral),
          dh(mine.privateKey, theirEphemeral),
          dh(myEphemeral.privateKey, theirs),
        ]
      : [
          dh(myEphemeral.privateKey, theirEphemeral),
          dh(myEphemeral.privateKey, theirs),
          dh(mine.privateKey, theirEphemeral),
        ];
  const transcript = crypto
    .createHash("sha256")
    .update(hello)
    .update("\n")
    .update(welcome)
    .digest();
  const okm = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.concat(parts),
      code ? unb64u(code) : Buffer.alloc(32),
      Buffer.concat([INFO, transcript]),
      64,
    ),
  );
  const toMac = okm.subarray(0, 32);
  const toPhone = okm.subarray(32, 64);
  return side === "phone"
    ? new Channel(toMac, toPhone)
    : new Channel(toPhone, toMac);
}

class Channel {
  constructor(sendKey, receiveKey) {
    this.sendKey = Buffer.from(sendKey);
    this.receiveKey = Buffer.from(receiveKey);
    this.sent = 0n;
    this.received = 0n;
  }
  static nonce(counter) {
    const n = Buffer.alloc(12);
    n.writeBigUInt64BE(counter, 4);
    return n;
  }
  seal(message) {
    let body = Buffer.from(JSON.stringify(message));
    let flag = 0;
    if (body.length > COMPRESS_OVER) {
      body = zlib.deflateRawSync(body, { level: 1 });
      flag = 1;
    }
    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      this.sendKey,
      Channel.nonce(this.sent++),
      { authTagLength: 16 },
    );
    const out = Buffer.concat([
      cipher.update(Buffer.concat([Buffer.from([flag]), body])),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return out;
  }
  open(frame) {
    const data = Buffer.from(frame);
    if (data.length < 17) throw new Error("short frame");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.receiveKey,
      Channel.nonce(this.received),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]);
    this.received++;
    const body =
      plain[0] === 1
        ? zlib.inflateRawSync(plain.subarray(1))
        : plain.subarray(1);
    return JSON.parse(body.toString("utf8"));
  }
}

// The text a phone scans: otter://pair?d=<base64url JSON>.
function pairingLink(info) {
  return `otter://pair?d=${b64u(Buffer.from(JSON.stringify(info)))}`;
}
function readPairingLink(link) {
  const d = new URL(link).searchParams.get("d");
  return JSON.parse(unb64u(d).toString("utf8"));
}
const deviceId = (pub) =>
  crypto.createHash("sha256").update(unb64u(pub)).digest("hex").slice(0, 12);

module.exports = {
  keyPair,
  loadKey,
  deriveKeys,
  Channel,
  pairingLink,
  readPairingLink,
  deviceId,
  b64u,
  unb64u,
};
