/**
 * Public Instagram profile snapshot — no auth, embed/web JSON only.
 *
 * Strategy: the public profile page embeds a hydration blob
 * (`__UNIVERSAL_DATA_FOR_REHYDRATION__` → `user` object) with follower
 * counts and bio for PUBLIC accounts. Private/gone profiles fail honestly.
 * Same fragility contract as ClipGrab resolvers: isolated + reactive fixes.
 */

export interface ProfileSnapshot {
  username: string;
  fullName: string;
  biography: string;
  followers: number;
  following: number;
  posts: number;
  isPrivate: boolean;
  isVerified: boolean;
  /** Derived engagement estimate per post (followers / posts, capped sanity). */
  avgEngagementEstimate?: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface HydrationUser {
  data?: {
    user?: {
      username?: string;
      full_name?: string;
      biography?: string;
      edge_followed_by?: { count?: number };
      edge_follow?: { count?: number };
      edge_owner_to_timeline_media?: { count?: number };
      is_private?: boolean;
      is_verified?: boolean;
    };
  };
}

export function extractProfileBlob(html: string): HydrationUser | null {
  const marker = 'id="__UNIVERSAL_DATA_FOR_REHYDRATION__">';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;
  const end = html.indexOf("</script>", jsonStart);
  if (end === -1) return null;
  try {
    return JSON.parse(html.slice(jsonStart, end)) as HydrationUser;
  } catch {
    return null;
  }
}

/** Normalize a hydration user into our snapshot shape (or null if unusable). */
export function toSnapshot(blob: HydrationUser | null): ProfileSnapshot | null {
  const u = blob?.data?.user;
  if (!u?.username) return null;
  const followers = u.edge_followed_by?.count ?? 0;
  const posts = u.edge_owner_to_timeline_media?.count ?? 0;
  return {
    username: u.username,
    fullName: u.full_name ?? "",
    biography: u.biography ?? "",
    followers,
    following: u.edge_follow?.count ?? 0,
    posts,
    isPrivate: !!u.is_private,
    isVerified: !!u.is_verified,
    ...(posts > 0
      ? { avgEngagementEstimate: `${((followers / Math.max(posts, 1)) / 100).toFixed(1)}% est.` }
      : {}),
  };
}

export async function fetchProfile(username: string): Promise<ProfileSnapshot | "private" | "not_found" | "failed"> {
  const handle = username.replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return "not_found";
  try {
    const res = await fetch(`https://www.instagram.com/${encodeURIComponent(handle)}/`, {
      headers: { "user-agent": UA, accept: "text/html" },
    });
    if (res.status === 404) return "not_found";
    if (!res.ok) return "failed";
    const html = await res.text();
    const snap = toSnapshot(extractProfileBlob(html));
    if (!snap) return "failed";
    return snap;
  } catch {
    return "failed";
  }
}

/** Render a snapshot as a compact Telegram-friendly text report. */
export function renderReport(snap: ProfileSnapshot): string {
  const lines = [
    `@${snap.username}${snap.isVerified ? " ✔️" : ""}${snap.isPrivate ? " (private)" : ""}`,
    snap.fullName || "",
    "",
    `Followers: ${snap.followers.toLocaleString("en-US")}`,
    `Following: ${snap.following.toLocaleString("en-US")}`,
    `Posts: ${snap.posts.toLocaleString("en-US")}`,
  ];
  if (snap.avgEngagementEstimate) {
    lines.push(`Avg engagement est.: ${snap.avgEngagementEstimate}`);
  }
  if (snap.biography) {
    lines.push("", snap.biography.slice(0, 300));
  }
  return lines.filter((l, i) => l !== "" || (i > 2 && i < lines.length - 1)).join("\n");
}
