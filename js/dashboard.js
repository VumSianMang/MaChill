import { supabase } from "./supabase-config.js";
import { searchPeople } from "./users.js";

function initials(name) {
  return (name || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

async function main() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return; // auth.js sends us to index.html
  const user = session.user;

  const { data: me } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  document.getElementById("account-photo").src = me?.avatar_url || "";
  document.getElementById("account-name").textContent = (me?.display_name || "").split(" ")[0] || "You";
  document.getElementById("account-id").textContent = me?.machill_id ? `#${me.machill_id}` : "";

  // ---- invite-link auto-join: dashboard.html?join=<groupId> ----
  const joinId = new URLSearchParams(location.search).get("join");
  if (joinId) {
    const { data: group } = await supabase.from("groups").select("id").eq("id", joinId).maybeSingle();
    if (group) {
      await supabase.from("group_members").upsert(
        { group_id: joinId, user_id: user.id, display_name: me?.display_name, avatar_url: me?.avatar_url },
        { onConflict: "group_id,user_id" }
      );
    }
    location.href = `group.html?g=${joinId}`;
    return;
  }

  // ---- people search + selection ----
  const searchInput = document.getElementById("people-search-input");
  const resultsBox = document.getElementById("people-results");
  const chipRow = document.getElementById("selected-chips");
  const selected = new Map(); // id -> profile row

  function renderChips() {
    chipRow.innerHTML = Array.from(selected.values())
      .map(
        (p) => `
        <span class="chip" data-id="${p.id}">
          <img src="${p.avatar_url || ""}" alt="" />
          ${escapeHtml((p.display_name || "Guest").split(" ")[0])}
          <button type="button" data-remove="${p.id}">×</button>
        </span>`
      )
      .join("");
  }
  chipRow.addEventListener("click", (e) => {
    const id = e.target.closest("[data-remove]")?.dataset.remove;
    if (!id) return;
    selected.delete(id);
    renderChips();
    renderResults(lastResults);
  });

  let lastResults = [];
  function renderResults(list) {
    lastResults = list;
    resultsBox.innerHTML = list
      .map((p) => {
        const added = selected.has(p.id);
        return `
        <div class="person-row ${added ? "added" : ""}" data-id="${p.id}">
          <img src="${p.avatar_url || ""}" alt="" />
          <div class="p-col">
            <div class="p-name">${escapeHtml(p.display_name || "Guest")}</div>
            <div class="p-id">#${escapeHtml(p.machill_id || "")}</div>
          </div>
          <button type="button">${added ? "Added" : "Add"}</button>
        </div>`;
      })
      .join("");
  }
  resultsBox.addEventListener("click", (e) => {
    const id = e.target.closest(".person-row")?.dataset.id;
    if (!id) return;
    const person = lastResults.find((p) => p.id === id);
    if (!person) return;
    if (selected.has(id)) selected.delete(id);
    else selected.set(id, person);
    renderChips();
    renderResults(lastResults);
  });

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const term = searchInput.value;
    if (!term.trim()) {
      resultsBox.innerHTML = "";
      return;
    }
    searchTimer = setTimeout(async () => {
      renderResults(await searchPeople(term, user.id));
    }, 300);
  });

  // ---- create group ----
  const createBtn = document.getElementById("create-group-btn");
  createBtn.addEventListener("click", async () => {
    const name = document.getElementById("group-name-input").value.trim();
    if (!name) {
      alert("Give the group a name first.");
      return;
    }
    createBtn.disabled = true;
    createBtn.textContent = "Creating…";
    try {
      const { data: group, error: groupErr } = await supabase
        .from("groups")
        .insert({ name, owner_id: user.id })
        .select()
        .single();
      if (groupErr) throw groupErr;

      const memberRows = [
        { group_id: group.id, user_id: user.id, display_name: me?.display_name, avatar_url: me?.avatar_url },
        ...Array.from(selected.values()).map((p) => ({
          group_id: group.id,
          user_id: p.id,
          display_name: p.display_name,
          avatar_url: p.avatar_url,
        })),
      ];
      const { error: memberErr } = await supabase.from("group_members").insert(memberRows);
      if (memberErr) throw memberErr;

      location.href = `group.html?g=${group.id}`;
    } catch (err) {
      console.error(err);
      alert("Couldn't create the group — check your Supabase setup and try again.");
      createBtn.disabled = false;
      createBtn.textContent = "Create group";
    }
  });

  // ---- your groups (live) ----
  const grid = document.getElementById("groups-grid");
  const emptyMsg = document.getElementById("groups-empty");

  async function loadGroups() {
    const { data: rows, error } = await supabase
      .from("group_members")
      .select("group_id, groups(id, name, created_at)")
      .eq("user_id", user.id);
    if (error) {
      console.error(error);
      return;
    }
    const groups = (rows || []).map((r) => r.groups).filter(Boolean);
    if (!groups.length) {
      emptyMsg.hidden = false;
      grid.innerHTML = "";
      return;
    }
    const { data: allMembers } = await supabase
      .from("group_members")
      .select("group_id")
      .in("group_id", groups.map((g) => g.id));
    const counts = {};
    (allMembers || []).forEach((m) => (counts[m.group_id] = (counts[m.group_id] || 0) + 1));

    groups.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    emptyMsg.hidden = true;
    grid.innerHTML = groups
      .map(
        (g) => `
        <button class="group-card" data-id="${g.id}">
          <span class="g-avatar">${escapeHtml(initials(g.name))}</span>
          <span class="g-name">${escapeHtml(g.name)}</span>
          <span class="g-meta">${counts[g.id] || 1} member${(counts[g.id] || 1) === 1 ? "" : "s"}</span>
        </button>`
      )
      .join("");
  }
  grid.addEventListener("click", (e) => {
    const id = e.target.closest("[data-id]")?.dataset.id;
    if (id) location.href = `group.html?g=${id}`;
  });

  await loadGroups();

  // Refresh the list live if we get added to a group from elsewhere.
  supabase
    .channel(`my-groups:${user.id}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "group_members", filter: `user_id=eq.${user.id}` },
      loadGroups
    )
    .subscribe();
}

main();
