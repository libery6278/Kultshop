const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeFile(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

function sanitizeFilename(name) {
  return name.replace(/[?#].*$/, '').replace(/\/+$/,'').replace(/[^A-Za-z0-9._-]/g, '_');
}

function getTypeByExt(ext) {
  const e = ext.toLowerCase();
  if (e === '.css') return 'css';
  if (e === '.js' || e === '.mjs' || e === '.cjs') return 'js';
  if (['.png','.jpg','.jpeg','.gif','.webp','.svg','.bmp','.ico','.avif'].includes(e)) return 'images';
  if (['.woff','.woff2','.ttf','.otf','.eot'].includes(e)) return 'fonts';
  return 'assets';
}

function typeFromContentType(ct) {
  if (!ct) return 'assets';
  const c = ct.toLowerCase();
  if (c.includes('text/css')) return 'css';
  if (c.includes('javascript')) return 'js';
  if (c.includes('image/')) return 'images';
  if (c.includes('font/') || c.includes('application/font') || c.includes('woff')) return 'fonts';
  return 'assets';
}

function normalizeUrl(u, base) {
  if (!u) return null;
  const s = u.trim().replace(/^"|^'|"$|'$/g, '');
  if (/^data:/i.test(s)) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return 'https:' + s;
  if (base) {
    try { return new URL(s, base).toString(); } catch { return null; }
  }
  return null;
}

function requestOnce(u, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = u.startsWith('https://') ? https : http;
    const req = lib.request(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.kulturafilipino.com' }, timeout: 20000, ...opts }, res => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        resolve({ redirect: normalizeUrl(res.headers.location, u) });
        return;
      }
      if (status < 200 || status >= 300) {
        reject(new Error('HTTP ' + status + ' ' + u));
        return;
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Timeout ' + u)); });
    req.end();
  });
}

async function fetchBuffer(u, maxRedirects = 5) {
  let current = u;
  for (let i = 0; i <= maxRedirects; i++) {
    const r = await requestOnce(current);
    if (r.redirect) { current = r.redirect; continue; }
    return { buffer: r.buffer, contentType: r.contentType, finalUrl: current };
  }
  throw new Error('Too many redirects ' + u);
}

function ensureUnique(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p);
  const base = path.basename(p, path.extname(p));
  const ext = path.extname(p);
  let i = 1;
  while (true) {
    const candidate = path.join(dir, base + '_' + i + ext);
    if (!fs.existsSync(candidate)) return candidate;
    i++;
  }
}

function collectHtmlUrls(html) {
  const urls = new Map();
  const push = (u) => { if (u) urls.set(u, true); };
  const attrRegexes = [
    /<link[^>]*href=["']([^"']+)["'][^>]*>/gi,
    /<script[^>]*src=["']([^"']+)["'][^>]*>/gi,
    /<img[^>]*src=["']([^"']+)["'][^>]*>/gi,
    /<source[^>]*srcset=["']([^"']+)["'][^>]*>/gi,
    /\sstyle=["'][^"']*url\(([^)]+)\)[^"']*["']/gi
  ];
  for (const re of attrRegexes) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const v = m[1];
      if (re === attrRegexes[3]) {
        const parts = v.split(',');
        for (const p of parts) {
          const u = p.trim().split(/\s+/)[0];
          push(u);
        }
      } else {
        push(v);
      }
    }
  }
  const styleBlockRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let sbm;
  while ((sbm = styleBlockRe.exec(html)) !== null) {
    const css = sbm[1];
    const list = extractCssUrls(css, null);
    for (const it of list) push(it.raw);
  }
  let m;
  const attrGeneric = /(href|src|poster|content|data-src|data-bg|data-variant-image)=["']([^"']+)["']/gi;
  while ((m = attrGeneric.exec(html)) !== null) {
    push(m[2]);
  }
  const attrSet = /(srcset|data-srcset|data-bgset)=["']([^"']+)["']/gi;
  while ((m = attrSet.exec(html)) !== null) {
    const v = m[2];
    const parts = v.split(',');
    for (const p of parts) {
      const u = p.trim().split(/\s+/)[0];
      push(u);
    }
  }
  return Array.from(urls.keys());
}

function decideLocalPath(u, baseDir) {
  const parsed = new URL(u);
  const ext = path.extname(parsed.pathname) || '';
  const type = getTypeByExt(ext);
  let name = path.basename(parsed.pathname) || 'file';
  name = sanitizeFilename(name);
  const dir = path.join(baseDir, type);
  fs.mkdirSync(dir, { recursive: true });
  return ensureUnique(path.join(dir, name));
}

async function downloadOne(u, baseDir) {
  const { buffer, contentType, finalUrl } = await fetchBuffer(u);
  let localPath = decideLocalPath(finalUrl, baseDir);
  const typeFromCt = typeFromContentType(contentType);
  if (typeFromCt !== 'assets') {
    const dir = path.join(baseDir, typeFromCt);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.basename(localPath);
    localPath = ensureUnique(path.join(dir, file));
  }
  writeFile(localPath, buffer);
  return { localPath, contentType, finalUrl };
}

function extractCssUrls(css, base) {
  const results = [];
  const re = /url\(\s*([^\)]+)\s*\)/gi;
  let m;
  while ((m = re.exec(css)) !== null) {
    let raw = m[1].trim();
    raw = raw.replace(/^"|^'|"$|'$/g, '');
    const abs = normalizeUrl(raw, base);
    if (abs) results.push({ raw, abs });
  }
  const reImp = /@import\s+(?:url\()?\s*(["']?[^"'\)]+["']?)\s*\)?/gi;
  while ((m = reImp.exec(css)) !== null) {
    let raw = m[1].trim();
    raw = raw.replace(/^"|^'|"$|'$/g, '');
    const abs = normalizeUrl(raw, base);
    if (abs) results.push({ raw, abs });
  }
  const uniq = new Map();
  for (const r of results) uniq.set(r.abs, r);
  return Array.from(uniq.values());
}

async function processCssFile(localPath, sourceUrl, baseDir, map) {
  let css = fs.readFileSync(localPath, 'utf8');
  const urls = extractCssUrls(css, sourceUrl);
  for (const { raw, abs } of urls) {
    if (!map[abs]) {
      try {
        const r = await downloadOne(abs, baseDir);
        map[abs] = path.relative(path.dirname(localPath), r.localPath).replace(/\\/g, '/');
        if (r.contentType && String(r.contentType).toLowerCase().includes('text/css')) {
          await processCssFile(r.localPath, r.finalUrl, baseDir, map);
        }
      } catch (e) {}
    }
  }
  for (const { raw, abs } of urls) {
    if (map[abs]) {
      css = css.replaceAll(raw, map[abs]);
    }
  }
  fs.writeFileSync(localPath, css);
}

async function main() {
  const cwd = process.cwd();
  const htmlPathArg = process.argv[2] || 'index.html';
  const htmlPath = path.isAbsolute(htmlPathArg) ? htmlPathArg : path.join(cwd, htmlPathArg);
  const assetsDir = path.join(cwd, 'assets');
  const html = readFile(htmlPath);
  const rawUrls = collectHtmlUrls(html);
  const normalized = [];
  const widthTplChoice = {};
  const reTpl = /data-src=["']([^"']*\{width\}[^"']*)["']/gi;
  let m;
  while ((m = reTpl.exec(html)) !== null) {
    const tpl = m[1];
    let tagEnd = html.indexOf('>', reTpl.lastIndex);
    if (tagEnd === -1) tagEnd = reTpl.lastIndex + 200;
    const slice = html.slice(reTpl.lastIndex, tagEnd);
    let widths = [];
    const wm = slice.match(/data-widths=["']\[([^"']+)\]["']/i);
    if (wm) {
      widths = wm[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    }
    if (widths.length === 0) widths = [400, 800, 1400];
    const chosen = Math.max(...widths);
    const abs = normalizeUrl(tpl.replace('{width}', String(chosen)));
    if (abs) {
      normalized.push(abs);
      widthTplChoice[tpl] = abs;
    }
  }
  for (const u of rawUrls) {
    const abs = normalizeUrl(u);
    if (abs) normalized.push(abs);
  }
  const anyCdnRe = /["']((?:https?:\\\/\\\/|\\\/\\\/)www\.kulturafilipino\.com\\\/cdn\\\/[^"']+)["']/gi;
  while ((m = anyCdnRe.exec(html)) !== null) {
    const ru = m[1];
    const abs = normalizeUrl(ru);
    if (abs) {
      normalized.push(abs);
      rawUrls.push(ru);
    }
  }
  const anyCdnRePlain = /["']((?:https?:\/\/|\/\/)www\.kulturafilipino\.com\/cdn\/[^"']+)["']/gi;
  while ((m = anyCdnRePlain.exec(html)) !== null) {
    const ru = m[1];
    const abs = normalizeUrl(ru);
    if (abs) {
      normalized.push(abs);
      rawUrls.push(ru);
    }
  }
  const uniq = Array.from(new Set(normalized));
  const map = {};
  const mapRaw = {};
  for (const u of uniq) {
    try {
      const r = await downloadOne(u, assetsDir);
      map[u] = path.relative(path.dirname(htmlPath), r.localPath).replace(/\\/g, '/');
      if (r.contentType && String(r.contentType).toLowerCase().includes('text/css')) {
        await processCssFile(r.localPath, r.finalUrl, assetsDir, map);
      }
    } catch (e) {}
  }
  for (const ru of rawUrls) {
    const abs = normalizeUrl(ru);
    if (abs && map[abs]) mapRaw[ru] = map[abs];
  }
  let updated = html;
  for (const u of Object.keys(map)) {
    const local = map[u];
    updated = updated.split(u).join(local);
    const escaped = u.replace(/\//g, '\\/');
    updated = updated.split(escaped).join(local);
  }
  for (const u of Object.keys(mapRaw)) {
    const local = mapRaw[u];
    updated = updated.split(u).join(local);
    const escaped = u.replace(/\//g, '\\/');
    updated = updated.split(escaped).join(local);
  }
  for (const tpl of Object.keys(widthTplChoice)) {
    const remote = widthTplChoice[tpl];
    if (map[remote]) {
      updated = updated.split(tpl).join(map[remote]);
    }
  }
  updated = updated.replace(/background-image:\s*url\((?:https?:\/\/|\/\/)www\.kulturafilipino\.com\/cdn\/[^)]+\);\s*/g, '');
  writeFile(htmlPath, updated);
  console.log('Completed. Saved assets to', path.relative(cwd, assetsDir));
}

main().catch(e => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });