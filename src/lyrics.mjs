// Adapted from desk-companion/collector/lyrics.mjs (MIT); timestamps use seconds.
export function parseLrc(raw = '', translated = '') {
  const parse = (text) => {
    const offset = Number(text.match(/\[offset:\s*([+-]?\d+)\]/i)?.[1] || 0) / 1000;
    const lines = [];
    for (const row of text.split(/\r?\n/)) {
      const tags = [...row.matchAll(/\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
      const value = row.replace(/\[[^\]]*\]/g, '').trim();
      if (!value) continue;
      for (const tag of tags) {
        if (+tag[2] >= 60) continue;
        lines.push({
          time: Math.max(0, +tag[1] * 60 + +tag[2] + Number(`0.${tag[3] || 0}`) - offset),
          text: value,
        });
      }
    }
    return lines.sort((a, b) => a.time - b.time);
  };
  const translations = parse(translated);
  return parse(raw).map((line) => ({
    ...line,
    translation: translations.find((item) => Math.abs(item.time - line.time) < 0.12)?.text || '',
  }));
}

export function lyricAt(lines, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Invalid playback position');
  let lo = 0,
    hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].time <= seconds) lo = mid + 1;
    else hi = mid;
  }
  return { index: lo - 1, current: lines[lo - 1] ?? null, next: lines[lo] ?? null };
}
