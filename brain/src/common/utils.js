import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function safeReadFile(p, encoding = 'utf8') {
  try {
    return fs.readFileSync(p, encoding);
  } catch {
    return null;
  }
}

/** "16 min ago" / "2 h ago" / "3 d ago" — matches the macOS launcher's subtitles. */
export function relativeAge(mtimeMs, nowMs = Date.now()) {
  const delta = Math.max(0, nowMs - mtimeMs);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function timeOfDay(date = new Date()) {
  const h = date.getHours();
  if (h < 5) return 'late night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function fileIconFor(p, stat) {
  if (stat?.isDirectory()) return { icon_kind: 'named', icon: 'folder' };
  const ext = path.extname(p).toLowerCase().replace('.', '');
  const map = {
    pdf: 'x-office-document',
    doc: 'x-office-document',
    docx: 'x-office-document',
    odt: 'x-office-document',
    txt: 'text-x-generic',
    md: 'text-x-generic',
    png: 'image-x-generic',
    jpg: 'image-x-generic',
    jpeg: 'image-x-generic',
    gif: 'image-x-generic',
    webp: 'image-x-generic',
    svg: 'image-x-generic',
    mp4: 'video-x-generic',
    mkv: 'video-x-generic',
    mp3: 'audio-x-generic',
    wav: 'audio-x-generic',
    zip: 'package-x-generic',
    tar: 'package-x-generic',
    gz: 'package-x-generic',
    AppImage: 'application-x-executable',
    sh: 'text-x-script',
    js: 'text-x-script',
    py: 'text-x-script',
  };
  return { icon_kind: 'named', icon: map[ext] ?? 'text-x-generic' };
}

export function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/** Short ids the model sees: c0, c1, ... cN. */
export const candidateId = (i) => `c${i}`;

export function decodeFileUri(uri) {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, ''));
  } catch {
    return null;
  }
}
