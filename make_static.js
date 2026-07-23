// JSONをパスワードで暗号化して data/*.enc に出力（GitHub Pages静的配信用）。
// ブラウザのWebCryptoと同一仕様（PBKDF2-SHA256 100k + AES-GCM）。復号はページ側で行う。
// 使い方: node make_static.js  （/tmp/s_*.json を読む）
const fs = require('fs');
const { webcrypto } = require('crypto');
const subtle = webcrypto.subtle;
const PW = process.env.MAP_PW || 'ody-map';

async function deriveKey(salt){
  const km = await subtle.importKey('raw', new TextEncoder().encode(PW), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({name:'PBKDF2', salt, iterations:100000, hash:'SHA-256'}, km,
    {name:'AES-GCM', length:256}, false, ['encrypt']);
}
async function enc(inPath, outPath){
  const data = fs.readFileSync(inPath); // bytes (utf-8 JSON)
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv   = webcrypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveKey(salt);
  const ct   = new Uint8Array(await subtle.encrypt({name:'AES-GCM', iv}, key, data));
  const out  = new Uint8Array(16 + 12 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  fs.writeFileSync(outPath, Buffer.from(out));
  console.log(outPath, '←', inPath, '(', ct.length, 'bytes )');
}
(async () => {
  const map = [
    ['/tmp/s_active.json',     'data/active.enc'],
    ['/tmp/s_cx.json',         'data/cx.enc'],
    ['/tmp/s_depot.json',      'data/depot.enc'],
    ['/tmp/s_geocache.json',   'data/geocache.enc'],
    ['/tmp/s_unresolved.json', 'data/unresolved.enc'],
  ];
  for (const [i,o] of map){ if (fs.existsSync(i)) await enc(i,o); }
})();
