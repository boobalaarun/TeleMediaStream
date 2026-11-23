// Range handling and response headers, mirroring the app's own /dl/ route.

// Returns { start, end } or null when the range can't be satisfied (416).
export function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1 }
  const value = header.replace('bytes=', '').trim()
  const parts = value.split('-')
  if (parts.length !== 2) return null
  const [a, b] = parts
  let start, end
  if (a === '') {
    if (!/^\d+$/.test(b)) return null
    start = size - Number(b)
    end = size - 1
  } else if (b === '') {
    if (!/^\d+$/.test(a)) return null
    start = Number(a)
    end = size - 1
  } else {
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null
    start = Number(a)
    end = Number(b)
  }
  if (start < 0) start = 0
  if (end >= size) end = size - 1
  if (end < start) return null
  return { start, end }
}

const MIME_BY_EXT = {
  mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo',
  mov: 'video/quicktime', ts: 'video/mp2t', m2ts: 'video/mp2t', flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', srt: 'application/x-subrip',
}

export function fileNameAndMime(info, urlName) {
  let name = info.name || ''
  let mime = info.mime || ''
  if (!name) {
    try { name = decodeURIComponent(urlName || '') } catch { name = urlName || '' }
  }
  if (!name) name = 'video.mkv'
  if (!mime) {
    const ext = (name.split('.').pop() || '').toLowerCase()
    mime = MIME_BY_EXT[ext] || 'application/octet-stream'
  }
  if (!name.includes('.') && mime.includes('/')) name = `${name}.${mime.split('/')[1]}`
  return { name, mime }
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '').replace(/"/g, '').trim() || 'file'
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function streamHeaders({ name, mime }, start, end, size, ranged) {
  const h = new Headers({
    'Content-Type': mime,
    'Content-Disposition': contentDisposition(name),
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Cache-Control': 'private, max-age=3600',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  })
  if (ranged) h.set('Content-Range', `bytes ${start}-${end}/${size}`)
  return h
}

export function text(status, message, extra) {
  return new Response(message + '\n', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...(extra || {}) },
  })
}
