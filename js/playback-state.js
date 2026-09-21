import { supabase } from "./supabase-config.js";

// Merges a partial patch into watch_sessions.playback atomically (server
// side, via the merge_playback() SQL function) instead of a client-side
// read-modify-write, which would race when two people act at once.
export async function writePlayback(groupId, uid, patch) {
  const { error } = await supabase.rpc("merge_playback", {
    p_group_id: groupId,
    p_patch: patch,
    p_updated_by: uid,
  });
  if (error) console.error("writePlayback failed", error);
}

export async function setMediaMode(groupId, mode, presenterUid = null) {
  const { error } = await supabase
    .from("watch_sessions")
    .upsert({ group_id: groupId, media_mode: mode, presenter_id: presenterUid }, { onConflict: "group_id" });
  if (error) console.error("setMediaMode failed", error);
}

export async function setSessionActive(groupId, active, extra = {}) {
  // group.js passes camelCase (startedBy, startedAt, mediaMode, playback) —
  // translate to the actual snake_case columns here.
  const keyMap = { startedBy: "started_by", startedAt: "started_at", mediaMode: "media_mode", presenterUid: "presenter_id" };
  const mapped = {};
  for (const [k, v] of Object.entries(extra)) mapped[keyMap[k] || k] = v;

  const { error } = await supabase
    .from("watch_sessions")
    .upsert({ group_id: groupId, active, ...mapped }, { onConflict: "group_id" });
  if (error) console.error("setSessionActive failed", error);
}

// Postgres columns are snake_case; the rest of the app was written expecting
// camelCase (mediaMode, presenterUid, ...) so we normalize once here.
function mapRow(row) {
  if (!row) return row;
  return {
    active: row.active,
    mediaMode: row.media_mode,
    presenterUid: row.presenter_id,
    startedBy: row.started_by,
    startedAt: row.started_at,
    playback: row.playback,
    updatedAt: row.updated_at,
  };
}

// One-time fetch of the current session row (may be null if the group has
// never started a watch session before).
export async function getSession(groupId) {
  const { data, error } = await supabase.from("watch_sessions").select("*").eq("group_id", groupId).maybeSingle();
  if (error) console.error("getSession failed", error);
  return mapRow(data);
}

// Subscribes to live changes on a group's session row. Returns an unsubscribe
// function. Callback receives the row in the same shape getSession() returns.
export function subscribeSession(groupId, callback) {
  const channel = supabase
    .channel(`session:${groupId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "watch_sessions", filter: `group_id=eq.${groupId}` },
      (payload) => callback(mapRow(payload.new))
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}
