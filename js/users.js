import { supabase } from "./supabase-config.js";

// Looks up people by name (prefix match, case-insensitive) or by their
// short MaChill ID (exact match). Returns [{id, display_name, avatar_url,
// machill_id}], excluding the current user.
export async function searchPeople(term, myUid) {
  const clean = term.trim();
  if (!clean) return [];
  const results = new Map();

  const idCandidate = clean.toUpperCase().replace(/\s/g, "");
  if (/^[A-Z0-9]{4,8}$/.test(idCandidate)) {
    const { data, error } = await supabase.from("profiles").select("*").eq("machill_id", idCandidate).maybeSingle();
    if (error) console.error("id search failed", error);
    if (data && data.id !== myUid) results.set(data.id, data);
  }

  const { data: nameMatches, error: nameErr } = await supabase
    .from("profiles")
    .select("*")
    .ilike("display_name", `${clean}%`)
    .limit(10);
  if (nameErr) console.error("name search failed", nameErr);
  (nameMatches || []).forEach((p) => {
    if (p.id !== myUid) results.set(p.id, p);
  });

  return Array.from(results.values());
}
