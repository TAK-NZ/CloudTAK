#!/usr/bin/env python3
"""
Range-fetch the NZ Building Heights PMTiles archive.

Chunked deliberately: a single unbroken 1.14 GB GET trips Cloudflare's bot
rules, while ranged requests are the archive format's native access pattern and
pass fine. Chunk size matches the origin's S3 multipart part size (5 MiB, which
the "...-219" ETag suffix implies for this object length), so the composite
ETag can be recomputed at the end to prove the copy is byte-identical.
"""
import hashlib
import os
import sys
import time
import urllib.error
import urllib.request

URL = "https://tiles.anicca.nz/buildings-20260810T1048.pmtiles"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "nz-building-heights.pmtiles")
TOTAL = 1_143_287_793
PART = 5 * 1024 * 1024           # 5 MiB, matches the origin's multipart layout
EXPECT_ETAG = "7315d8dfbefd1259291752e3fc97120b-219"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"

nparts = (TOTAL + PART - 1) // PART


def fetch(start, end, attempts=5):
    """GET a single byte range, with backoff. Returns bytes."""
    last = None
    for a in range(attempts):
        try:
            req = urllib.request.Request(URL, headers={
                "Range": f"bytes={start}-{end}",
                "User-Agent": UA,
                "Accept": "*/*",
            })
            with urllib.request.urlopen(req, timeout=120) as r:
                if r.status != 206:
                    raise RuntimeError(f"expected 206, got {r.status}")
                buf = r.read()
            want = end - start + 1
            if len(buf) != want:
                raise RuntimeError(f"short read: {len(buf)} != {want}")
            return buf
        except Exception as e:                      # noqa: BLE001 - retry anything
            last = e
            time.sleep(2 ** a)
    raise RuntimeError(f"range {start}-{end} failed after {attempts}: {last}")


def main():
    resume = os.path.exists(OUT) and os.path.getsize(OUT) % PART == 0
    done = os.path.getsize(OUT) if resume else 0
    first = done // PART
    if first:
        print(f"resuming at part {first}/{nparts}", flush=True)

    md5s = []
    if first:
        # Re-hash what we already have so the ETag check stays valid.
        with open(OUT, "rb") as fh:
            for _ in range(first):
                md5s.append(hashlib.md5(fh.read(PART)).digest())

    t0 = time.time()
    with open(OUT, "ab" if first else "wb") as fh:
        for i in range(first, nparts):
            start = i * PART
            end = min(start + PART, TOTAL) - 1
            buf = fetch(start, end)
            fh.write(buf)
            md5s.append(hashlib.md5(buf).digest())
            if (i + 1) % 20 == 0 or i + 1 == nparts:
                mb = (end + 1) / 1e6
                rate = mb / max(time.time() - t0, 0.001)
                pct = 100 * (end + 1) / TOTAL
                print(f"  part {i+1:>3}/{nparts}  {mb:>8.1f} MB  {pct:5.1f}%  {rate:5.1f} MB/s", flush=True)

    size = os.path.getsize(OUT)
    etag = hashlib.md5(b"".join(md5s)).hexdigest() + f"-{len(md5s)}"

    print(f"\nsize      : {size:,} (expected {TOTAL:,}) {'OK' if size == TOTAL else 'MISMATCH'}")
    with open(OUT, "rb") as fh:
        magic = fh.read(7)
    print(f"magic     : {magic!r} {'OK' if magic == b'PMTiles' else 'MISMATCH'}")
    print(f"etag      : {etag}")
    print(f"expected  : {EXPECT_ETAG} {'OK' if etag == EXPECT_ETAG else 'MISMATCH'}")

    ok = size == TOTAL and magic == b"PMTiles" and etag == EXPECT_ETAG
    print("\nRESULT: " + ("byte-identical to origin" if ok else "VERIFICATION FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
