const fs = require('node:fs');
const { Transform, pipeline } = require('node:stream');

// Stream a request body to `dest` without holding it in memory; refuses (and removes the file) past `limit` bytes.
function bodyToFile(req, dest, limit) {
  return new Promise((resolve) => {
    let n = 0;
    let over = false;
    const limitBytes = new Transform({
      transform(chunk, _encoding, callback) {
        n += chunk.length;
        if (n > limit) {
          over = true;
          callback();
          return;
        }
        callback(null, chunk);
      },
    });
    pipeline(req, limitBytes, fs.createWriteStream(dest), (error) => {
      if (error || over) {
        fs.rmSync(dest, { force: true });
        resolve(null);
        return;
      }
      resolve(n);
    });
  });
}

// A multipart/form-data body on disk -> the first file part, written to `dest`. Reads only the head and tail of the
// file to find the part, then copies the middle. Returns its size or null.
async function extractFilePart(src, contentType, dest) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('\r\n--' + (m[1] || m[2]));
  const fd = fs.openSync(src, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 16384));
    fs.readSync(fd, head, 0, head.length, 0);
    const start0 = head.indexOf('\r\n\r\n');
    if (start0 < 0 || !/filename=/i.test(head.subarray(0, start0).toString('latin1'))) return null;
    const dataStart = start0 + 4;
    const tail = Buffer.alloc(Math.min(size, boundary.length + 16));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const at = tail.lastIndexOf(boundary);
    if (at < 0) return null;
    const dataEnd = size - tail.length + at; // exclusive
    if (dataEnd <= dataStart) return null;
    await new Promise((resolve, reject) => {
      const r = fs.createReadStream(src, { start: dataStart, end: dataEnd - 1 });
      const w = fs.createWriteStream(dest);
      r.on('error', reject); w.on('error', reject); w.on('finish', resolve);
      r.pipe(w);
    });
    return dataEnd - dataStart;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { bodyToFile, extractFilePart };
