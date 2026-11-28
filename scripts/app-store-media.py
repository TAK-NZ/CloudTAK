#!/usr/bin/env python3
"""Prepare App Store Connect screenshots and app previews from raw device captures.

Needs Python 3 with Pillow, and ffmpeg and ffprobe for previews. Nothing is uploaded.
The sizes and limits are Apple's (App Store Connect Help, "Screenshot specifications" and
"App preview specifications"). Check them again before a release, Apple adds devices.

  screenshots   raw captures -> screenshots at the exact accepted size, no alpha channel
  preview       a screen recording -> an app preview video App Store Connect accepts
  check         report whether files already meet the requirements

Captures must come from the real app. Apple rejects screenshots and previews that are not
what the app looks like. A caption above the screenshot is fine, a made-up screen is not.

Examples:
  scripts/app-store-media.py screenshots --device iphone --in raw/iphone --out out/iphone \\
      --captions raw/captions.txt
  scripts/app-store-media.py preview --device iphone --in raw/preview.mov --out out/preview-iphone.mp4
  scripts/app-store-media.py check out/iphone/*.png out/preview-iphone.mp4

The captions file has one line per screenshot, `file name: caption`, for example
`01-map.png: See your team on one map`.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    sys.exit('Pillow is needed: pip install pillow')

# The size screenshots are produced at, and the other sizes Apple accepts as they are
SHOT = {
    # iPhone with Dynamic Island (large display), the largest required set
    'iphone': {'primary': (1320, 2868), 'accepted': {(1320, 2868), (1290, 2796), (1260, 2736)}},
    # iPad 13" display, required because the app runs on iPad
    'ipad': {'primary': (2064, 2752), 'accepted': {(2064, 2752), (2048, 2732)}},
}
# Accepted app preview resolutions (portrait)
PREVIEW = {'iphone': (886, 1920), 'ipad': (1200, 1600)}
PREVIEW_MIN_S, PREVIEW_MAX_S, PREVIEW_MAX_MB = 15, 30, 500

BG_TOP, BG_BOTTOM = (15, 23, 34), (32, 46, 66)
TEXT = (255, 255, 255)
FONT_PATHS = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    'C:/Windows/Fonts/arialbd.ttf',
]


def font(size):
    for path in FONT_PATHS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def gradient(size):
    w, h = size
    img = Image.new('RGB', size)
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        row = tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = row
    return img


def wrap(draw, text, fnt, width):
    lines, line = [], ''
    for word in text.split():
        trial = f'{line} {word}'.strip()
        if draw.textlength(trial, font=fnt) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def rounded(img, radius):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.size[0] - 1, img.size[1] - 1), radius, fill=255)
    out = Image.new('RGB', img.size, (0, 0, 0))
    out.paste(img, mask=mask)
    return out, mask


def flat(img):
    """Screenshots can't have an alpha channel: flatten onto white"""
    if img.mode in ('RGBA', 'LA') or 'transparency' in img.info:
        rgba = img.convert('RGBA')
        bg = Image.new('RGB', rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[3])
        return bg
    return img.convert('RGB')


def frame(raw, size, caption):
    """The capture below a caption, on a plain background, at exactly `size`"""
    w, h = size
    canvas = gradient(size)
    draw = ImageDraw.Draw(canvas)
    margin = round(w * 0.07)
    top = round(h * 0.035)
    text_h = 0
    if caption:
        fnt = font(round(w * 0.062))
        lines = wrap(draw, caption, fnt, w - 2 * margin)
        line_h = round(fnt.size * 1.22)
        for i, line in enumerate(lines):
            draw.text((w / 2, top + i * line_h), line, font=fnt, fill=TEXT, anchor='ma')
        text_h = len(lines) * line_h + round(h * 0.02)
    avail_h = h - top - text_h - round(h * 0.03)
    avail_w = w - 2 * margin
    scale = min(avail_w / raw.size[0], avail_h / raw.size[1])
    shot = raw.resize((round(raw.size[0] * scale), round(raw.size[1] * scale)), Image.LANCZOS)
    shot, mask = rounded(shot, round(shot.size[0] * 0.05))
    x = (w - shot.size[0]) // 2
    y = top + text_h
    canvas.paste(shot, (x, y), mask)
    return canvas


def read_captions(path):
    captions = {}
    if not path:
        return captions
    for line in Path(path).read_text().splitlines():
        if ':' in line and not line.lstrip().startswith('#'):
            name, text = line.split(':', 1)
            captions[name.strip()] = text.strip()
    return captions


def cmd_screenshots(args):
    spec = SHOT[args.device]
    src = sorted(p for p in Path(args.input).iterdir() if p.suffix.lower() in ('.png', '.jpg', '.jpeg'))
    if not src:
        sys.exit(f'No images in {args.input}')
    if len(src) > 10:
        sys.exit('App Store Connect takes at most 10 screenshots per device size')
    Path(args.out).mkdir(parents=True, exist_ok=True)
    captions = read_captions(args.captions)
    for p in src:
        raw = flat(Image.open(p))
        portrait = raw.size[1] > raw.size[0]
        if not portrait:
            print(f'warning: {p.name} is landscape, this tool produces portrait only', file=sys.stderr)
        if args.style == 'plain':
            if raw.size in spec['accepted']:
                out = raw
            else:
                out = raw.resize(spec['primary'], Image.LANCZOS)
                ratio = (raw.size[0] / raw.size[1]) / (spec['primary'][0] / spec['primary'][1])
                if abs(ratio - 1) > 0.02:
                    print(f'warning: {p.name} was stretched, its shape is not an {args.device} screen', file=sys.stderr)
        else:
            out = frame(raw, spec['primary'], captions.get(p.name))
        dest = Path(args.out) / (p.stem + '.png')
        out.save(dest, 'PNG', optimize=True)
        print(f'{dest}  {out.size[0]}x{out.size[1]}')


def probe(path):
    res = subprocess.run(
        ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', str(path)],
        capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def cmd_preview(args):
    w, h = PREVIEW[args.device]
    info = probe(args.input)
    duration = float(info['format']['duration'])
    if duration < PREVIEW_MIN_S:
        sys.exit(f'The recording is {duration:.1f} s. An app preview is {PREVIEW_MIN_S} to {PREVIEW_MAX_S} s')
    if duration > PREVIEW_MAX_S and not args.trim:
        sys.exit(f'The recording is {duration:.1f} s. Cut it, or pass --trim to keep the first {PREVIEW_MAX_S} s')
    has_audio = any(s['codec_type'] == 'audio' for s in info['streams'])
    cmd = ['ffmpeg', '-y', '-v', 'error', '-i', args.input]
    if not has_audio:
        # A silent stereo track, so the file always has the audio App Store Connect expects
        cmd += ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
    cmd += [
        '-vf', f'scale={w}:{h}:force_original_aspect_ratio=decrease,'
               f'pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,format=yuv420p',
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0',
        '-b:v', '10M', '-maxrate', '12M', '-bufsize', '24M',
        '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2',
        '-t', str(PREVIEW_MAX_S), '-movflags', '+faststart',
    ]
    if not has_audio:
        cmd += ['-shortest']
    cmd += [args.out]
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(cmd, check=True)
    problems = check_video(Path(args.out), args.device)
    print(f'{args.out}: ' + ('OK' if not problems else '; '.join(problems)))
    return 1 if problems else 0


def check_video(path, device=None):
    problems = []
    info = probe(path)
    video = next((s for s in info['streams'] if s['codec_type'] == 'video'), None)
    audio = next((s for s in info['streams'] if s['codec_type'] == 'audio'), None)
    if not video:
        return ['no video stream']
    size = (video['width'], video['height'])
    allowed = {PREVIEW[device], PREVIEW[device][::-1]} if device else set(PREVIEW.values()) | {v[::-1] for v in PREVIEW.values()}
    if size not in allowed:
        problems.append(f'size {size[0]}x{size[1]} is not an accepted preview size')
    if video.get('codec_name') != 'h264':
        problems.append(f"codec {video.get('codec_name')} is not H.264")
    num, den = (int(x) for x in video['avg_frame_rate'].split('/'))
    fps = num / den if den else 0
    if fps > 30.01:
        problems.append(f'{fps:.1f} fps is over 30')
    duration = float(info['format']['duration'])
    if not PREVIEW_MIN_S - 0.2 <= duration <= PREVIEW_MAX_S + 0.2:
        problems.append(f'{duration:.1f} s is outside {PREVIEW_MIN_S} to {PREVIEW_MAX_S} s')
    if path.stat().st_size > PREVIEW_MAX_MB * 1024 * 1024:
        problems.append(f'over {PREVIEW_MAX_MB} MB')
    if not audio:
        problems.append('no audio track')
    elif int(audio.get('channels', 0)) != 2:
        problems.append('audio is not stereo')
    return problems


def check_image(path):
    problems = []
    img = Image.open(path)
    allowed = set().union(*(s['accepted'] for s in SHOT.values()))
    if img.size not in allowed:
        problems.append(f'size {img.size[0]}x{img.size[1]} is not an accepted screenshot size')
    if img.mode in ('RGBA', 'LA') or 'transparency' in img.info:
        problems.append('has an alpha channel')
    if path.suffix.lower() not in ('.png', '.jpg', '.jpeg'):
        problems.append('not png or jpeg')
    return problems


def cmd_check(args):
    bad = 0
    for name in args.files:
        path = Path(name)
        if path.suffix.lower() in ('.mp4', '.mov', '.m4v'):
            problems = check_video(path)
        else:
            problems = check_image(path)
        print(f'{"FAIL" if problems else "ok  "}  {path}  {"; ".join(problems)}')
        bad += bool(problems)
    return 1 if bad else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('screenshots')
    s.add_argument('--device', choices=SHOT, required=True)
    s.add_argument('--in', dest='input', required=True, help='folder of raw captures, sorted by file name')
    s.add_argument('--out', required=True)
    s.add_argument('--captions', help='file with "file name: caption" lines')
    s.add_argument('--style', choices=('framed', 'plain'), default='framed',
                   help='framed: caption above the capture on a plain background. plain: the capture alone')
    p = sub.add_parser('preview')
    p.add_argument('--device', choices=PREVIEW, required=True)
    p.add_argument('--in', dest='input', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--trim', action='store_true', help='keep the first 30 s of a longer recording')
    c = sub.add_parser('check')
    c.add_argument('files', nargs='+')
    args = parser.parse_args()
    if args.cmd == 'screenshots':
        return cmd_screenshots(args) or 0
    if args.cmd == 'preview':
        return cmd_preview(args)
    return cmd_check(args)


if __name__ == '__main__':
    sys.exit(main())
