// Anonymous playtest ids. Nothing here identifies a person: a random id kept
// in this browser, a random id per tab visit, and the `src` tag of the
// invite link the player first arrived with.

import { SOURCE_RE } from "@ape/game";
import type { HelloTags } from "@ape/game";

function randomId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function kept(storage: () => Storage, key: string, make: () => string | null): string | null {
  try {
    const s = storage();
    const have = s.getItem(key);
    if (have !== null) return have;
    const v = make();
    if (v !== null) s.setItem(key, v);
    return v;
  } catch {
    // Storage blocked: the ids last for this page load only.
    return make();
  }
}

/** The link's `src` tag, cleaned, or null. */
export function sourceFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get("src")?.trim().toLowerCase() ?? "";
  return SOURCE_RE.test(raw) ? raw : null;
}

export function playtestTags(search: string): HelloTags {
  const linked = sourceFromUrl(search);
  // A dev link always marks this browser as the developer's, even after testing a group's link.
  if (linked === "dev") {
    try {
      localStorage.setItem("aor.src", "dev");
    } catch {
      // ignored
    }
  }
  return {
    anon: kept(() => localStorage, "aor.anon", randomId),
    // One tab visit; a reload in the same tab carries on the same session.
    session: kept(() => sessionStorage, "aor.session", randomId),
    // First touch wins: the group a player was invited from stays their group.
    source: kept(() => localStorage, "aor.src", () => linked) ?? linked,
  };
}

/** The tag an invite link passes on: a group, never the developer's own. */
export function inviteSource(source: string | null): string | null {
  return source === "dev" ? null : source;
}
