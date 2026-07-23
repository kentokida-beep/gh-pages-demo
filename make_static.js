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
// 暗号化バイト列を base64 にして window.__D_<name>="..." の .js として出力。
// → ブラウザは <script> タグで読み込む（社内プロキシがfetch/XHRや.encを塞いでも、
//    ライブラリと同じ <script> 経由なので通りやすい）。
async function enc(inPath, outPath, varName){
  const data = fs.readFileSync(inPath); // bytes (utf-8 JSON)
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv   = webcrypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveKey(salt);
  const ct   = new Uint8Array(await subtle.encrypt({name:'AES-GCM', iv}, key, data));
  const out  = new Uint8Array(16 + 12 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  const b64  = Buffer.from(out).toString('base64');
  fs.writeFileSync(outPath, 'window.__D_' + varName + '="' + b64 + '";');
  console.log(outPath, '←', inPath, '(', b64.length, 'b64 chars )');
}
(async () => {
  const map = [
    ['/tmp/s_active.json',     'data/active.js',     'active'],
    ['/tmp/s_cx.json',         'data/cx.js',         'cx'],
    ['/tmp/s_depot.json',      'data/depot.js',      'depot'],
    ['/tmp/s_geocache.json',   'data/geocache.js',   'geocache'],
    ['/tmp/s_unresolved.json', 'data/unresolved.js', 'unresolved'],
  ];
  for (const [i,o,v] of map){ if (fs.existsSync(i)) await enc(i,o,v); }
})();
