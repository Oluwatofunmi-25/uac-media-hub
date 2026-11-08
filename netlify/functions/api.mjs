// UAC Media Hub backend for Netlify. Needs the environment variable ADMIN_KEY.
import { getStore } from '@netlify/blobs';

export const config = { path: '/api/*' };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const isJpeg = b => { const a = new Uint8Array(b.slice(0, 3)); return a[0] === 0xFF && a[1] === 0xD8 && a[2] === 0xFF; };
const ID = /^[a-f0-9]{16}(_t)?$/, TOP = 9999999999999;
const hex = s => [...new TextEncoder().encode(s)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => { try { return new TextDecoder().decode(new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)))); } catch { return ''; } };

async function allMeta(meta) { // newest first: [{id, created, event}]
  const out = [];
  for await (const page of meta.list({ paginate: true })) for (const b of page.blobs) {
    const [rev, id, e = ''] = b.key.split('_');
    out.push({ id, created: TOP - Number(rev), event: unhex(e), key: b.key });
  }
  return out.sort((a, b) => b.created - a.created);
}

export default async (req, ctx) => {
  const p = new URL(req.url).pathname.split('/').filter(Boolean).slice(1), m = req.method, url = new URL(req.url);
  const photos = getStore('photos'), meta = getStore({ name: 'meta', consistency: 'strong' });
  try {
    if (m === 'GET' && p[0] === 'photos') {
      const ev = url.searchParams.get('event') || '', before = Number(url.searchParams.get('before')) || 9e15;
      const rows = (await allMeta(meta)).filter(r => r.created < before && (!ev || r.event === ev)).slice(0, 24);
      return J(rows.map(({ id, event, created }) => ({ id, event, created })));
    }
    if (m === 'GET' && p[0] === 'events') {
      const seen = new Map();
      for (const r of await allMeta(meta)) if (r.event) seen.set(r.event, (seen.get(r.event) || 0) + 1);
      return J([...seen].slice(0, 30).map(([event, n]) => ({ event, n })));
    }
    if (m === 'GET' && p[0] === 'photo') {
      if (!ID.test(p[1] || '')) return J({ error: 'Photo not found.' }, 404);
      const s = await photos.get(p[1], { type: 'stream' });
      if (!s) return J({ error: 'Photo not found.' }, 404);
      const h = new Headers({ 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' });
      if (url.searchParams.get('dl')) h.set('content-disposition', `attachment; filename="UAC-Media-Hub-${p[1].slice(0, 8)}.jpg"`);
      return new Response(s, { headers: h });
    }
    if (m === 'POST' && p[0] === 'upload') {
      const now = Date.now(), ip = String(ctx.ip || req.headers.get('x-nf-client-connection-ip') || 'x').replace(/[^a-zA-Z0-9]/g, '-');
      const hits = getStore('hits'), hk = ip + '_' + Math.floor(now / 3600e3), n = Number(await hits.get(hk)) || 0;
      if (n >= 60) return J({ error: 'Too many uploads from this device. Please try again in an hour.' }, 429);
      const f = await req.formData(), file = f.get('file'), th = f.get('thumb');
      if (!file || !th || typeof file === 'string' || typeof th === 'string') return J({ error: 'No photo received. Please try again.' }, 400);
      if (file.size > 5e6 || th.size > 5e5) return J({ error: 'This photo is too large. Please choose a smaller one.' }, 413);
      const [a, b] = await Promise.all([file.arrayBuffer(), th.arrayBuffer()]);
      if (!isJpeg(a) || !isJpeg(b)) return J({ error: 'Only photos can be uploaded.' }, 415);
      const id = [...crypto.getRandomValues(new Uint8Array(8))].map(x => x.toString(16).padStart(2, '0')).join('');
      const ev = String(f.get('event') || '').trim().slice(0, 80);
      await photos.set(id, a); await photos.set(id + '_t', b);
      await meta.set(String(TOP - now).padStart(13, '0') + '_' + id + '_' + hex(ev), '1');
      await hits.set(hk, String(n + 1));
      return J({ id });
    }
    if (m === 'DELETE' && p[0] === 'photo') {
      const key = process.env.ADMIN_KEY;
      if (!key || req.headers.get('x-admin-key') !== key) return J({ error: 'Wrong removal key.' }, 403);
      if (!ID.test(p[1] || '') || p[1].endsWith('_t')) return J({ error: 'Photo not found.' }, 404);
      const row = (await allMeta(meta)).find(r => r.id === p[1]);
      await photos.delete(p[1]); await photos.delete(p[1] + '_t'); if (row) await meta.delete(row.key);
      return J({ ok: true });
    }
    return J({ error: 'Not found.' }, 404);
  } catch (e) { return J({ error: 'Something went wrong on the server. Please try again.' }, 500); }
};
