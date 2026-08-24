/**
 * Subtitle/transcript formatting: Whisper segments -> SRT / VTT / TXT.
 * Pure functions, zero I/O — fully unit-testable.
 */

export interface Segment {
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  text: string;
}

/** 12.345 -> "00:00:12,345" (SRT) or "00:00:12.345" (VTT). */
export function formatTimestamp(seconds: number, msSep: "," | "."): string {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSep}${pad(ms, 3)}`;
}

export function toSrt(segments: readonly Segment[]): string {
  return (
    segments
      .map((seg, i) => {
        const timing = `${formatTimestamp(seg.start, ",")} --> ${formatTimestamp(seg.end, ",")}`;
        return `${i + 1}\n${timing}\n${seg.text.trim()}`;
      })
      .join("\n\n") + "\n"
  );
}

export function toVtt(segments: readonly Segment[]): string {
  if (segments.length === 0) {
    return "WEBVTT\n";
  }
  const cues = segments
    .map((seg) => {
      const timing = `${formatTimestamp(seg.start, ".")} --> ${formatTimestamp(seg.end, ".")}`;
      return timing + "\n" + seg.text.trim();
    })
    .join("\n\n");
  return "WEBVTT\n\n" + cues + "\n";
}

export function toTxt(segments: readonly Segment[]): string {
  return (
    segments
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ") + "\n"
  );
}
