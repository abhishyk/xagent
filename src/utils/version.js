// OS version detection (Spec §52). Product-name independent. Recognises e.g.
//   "<Name>OS 2.1", "<Name> OS v2.x", "OS-3", "Version: 2.4.1", "v1.x"
const PATTERNS = [
  /\b(?:[A-Za-z][\w-]*)?\s?OS\s*[-_ ]?\s*v?(\d+(?:\.(?:\d+|x))*)\b/,
  /\bversion\s*[:#]?\s*v?(\d+(?:\.(?:\d+|x))+)/i,
  /\bv(\d+\.(?:\d+|x)(?:\.(?:\d+|x))*)\b/i,
];

export function detectVersion(text) {
  if (!text) return null;
  for (const re of PATTERNS) {
    const m = String(text).match(re);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// "2.1.3" -> "2"; "2.x" -> "2"
export function majorOf(version) {
  if (!version) return null;
  return String(version).split('.')[0];
}

// True when two version strings are compatible at the precision both specify.
export function versionsCompatible(a, b) {
  if (!a || !b) return true;
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (pa[i] === 'x' || pb[i] === 'x') return true;
    if (pa[i] !== pb[i]) return false;
  }
  return true;
}
