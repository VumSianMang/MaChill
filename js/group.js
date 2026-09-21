import { supabase } from "./supabase-config.js";
import { initChat } from "./chat.js";
import { initCall } from "./call.js";
import { initYouTubeSync } from "./youtube-sync.js";
import { initLocalSync } from "./local-sync.js";
import { initDrive } from "./drive.js";
import { getSession, subscribeSession, setMediaMode, setSessionActive } from "./playback-state.js";

const groupId = new URLSearchParams(location.search).get("g");
if (!groupId) location.href = "dashboard.html";

function initials(name) {
  return (name || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

async function main() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return; // auth.js sends us to index.html

  const { data: myProfile } = await supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  // Normalized shape every module below expects (matches what Firebase's
  // User object used to look like, so those modules didn't need to change).
  const user = {
    uid: session.user.id,
    displayName: myProfile?.display_name || "Guest",
    photoURL: myProfile?.avatar_url || "",
  };

  const { data: groupRow } = await supabase.from("groups").select("*").eq("id", groupId).maybeSingle();
  if (!groupRow) {
    alert("That group doesn't exist (or was removed).");
    location.href = "dashboard.html";
    return;
  }

  // Direct/bookmarked links: make sure we're actually a member.
  const { data: myMembership } = await supabase
    .from("group_members")
    .select("group_id")
    .eq("group_id", groupId)
    .eq("user_id", user.uid)
    .maybeSingle();
  if (!myMembership) {
    await supabase
      .from("group_members")
      .upsert(
        { group_id: groupId, user_id: user.uid, display_name: user.displayName, avatar_url: user.photoURL },
        { onConflict: "group_id,user_id" }
      );
  }

  const { count: memberCount } = await supabase
    .from("group_members")
    .select("*", { count: "exact", head: true })
    .eq("group_id", groupId);

  document.getElementById("group-avatar").textContent = initials(groupRow.name);
  document.getElementById("group-name-text").textContent = groupRow.name;
  document.getElementById("group-meta-text").textContent = `${memberCount || 1} member${memberCount === 1 ? "" : "s"}`;
  document.getElementById("invite-group-name").textContent = groupRow.name;

  // ---- modules ----
  const youtubeSync = initYouTubeSync(groupId, user);
  const localSync = initLocalSync(groupId, user);
  const driveSync = initDrive(groupId, user);
  const chatCtl = initChat(groupId, user);
  const call = initCall(groupId, user, {
    onRemoteScreenActive: () => setStageForScreen(true),
    onRemoteScreenEnded: () => setStageForScreen(false),
  });

  const modules = { youtube: youtubeSync, local: localSync, drive: driveSync };
  const watchMain = document.getElementById("watch-main");
  const screenVideo = document.getElementById("screen-video");
  const stageEmpty = document.getElementById("stage-empty");
  const callBar = document.getElementById("call-bar");
  const startBtn = document.getElementById("start-session-btn");
  const callStrip = document.getElementById("call-strip");
  const presenterTag = document.getElementById("presenter-tag");

  let currentMode = null;

  function setStageForScreen(active) {
    if (currentMode !== "screen") return;
    screenVideo.style.display = active ? "block" : "none";
    stageEmpty.style.display = active ? "none" : "block";
  }

  function switchToMode(mode) {
    if (mode === currentMode) return;
    if (currentMode) modules[currentMode]?.deactivate?.();
    if (currentMode === "screen") setStageForScreen(false);
    currentMode = mode;

    ["youtube", "local", "drive", "screen"].forEach((m) => {
      const panel = document.getElementById(`mode-panel-${m}`);
      if (panel) panel.hidden = m !== mode;
    });

    if (mode === "screen") setStageForScreen(!!screenVideo.srcObject);
    else modules[mode]?.activate?.();
  }

  // ---- member name cache, for the "X is sharing" tag ----
  const nameCache = new Map();
  async function nameFor(uid) {
    if (uid === user.uid) return "You";
    if (nameCache.has(uid)) return nameCache.get(uid);
    const { data } = await supabase
      .from("group_members")
      .select("display_name")
      .eq("group_id", groupId)
      .eq("user_id", uid)
      .maybeSingle();
    const name = (data?.display_name || "Someone").split(" ")[0];
    nameCache.set(uid, name);
    return name;
  }

  // ---- watch session: mode, playback, presenter, active state ----
  // Note: we only ever *apply* this to the stage once we've actually joined
  // the session — otherwise someone just reading chat would have a YouTube
  // video silently start playing audio in the background.
  let sessionActive = false;
  let latestSessionData = null;

  async function applySessionData(data) {
    // If someone else switched the room away from screen share while we
    // were the presenter, stop our actual OS-level share too.
    if (data?.mediaMode !== "screen" && call.isSharing()) call.stopScreenShare();

    if (data?.mediaMode) switchToMode(data.mediaMode);
    youtubeSync.applyRemoteState(data?.playback);
    localSync.applyRemoteState(data?.playback);
    driveSync.applyRemoteState(data?.playback);

    if (data?.mediaMode === "screen" && data?.presenterUid) {
      const name = await nameFor(data.presenterUid);
      document.getElementById("presenter-avatar").textContent = initials(name);
      document.getElementById("presenter-name").textContent = `${name} is sharing`;
      presenterTag.hidden = false;
    } else {
      presenterTag.hidden = true;
    }
  }

  latestSessionData = await getSession(groupId);
  sessionActive = !!latestSessionData?.active;
  updateStartButton();

  subscribeSession(groupId, (data) => {
    latestSessionData = data;
    sessionActive = !!data?.active;
    updateStartButton();
    if (call.isInSession()) applySessionData(data);
  });

  function updateStartButton() {
    if (call.isInSession()) return;
    startBtn.innerHTML = sessionActive
      ? startBtn.innerHTML.replace(/Start|Join/, "Join")
      : startBtn.innerHTML.replace(/Start|Join/, "Start");
  }

  // ---- start / join the watch session ----
  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    try {
      await call.joinSession();
      if (!sessionActive) {
        const existing = await getSession(groupId);
        const extra = { startedBy: user.uid, startedAt: new Date().toISOString() };
        if (!existing || !existing.mediaMode) extra.mediaMode = "youtube";
        if (!existing || !existing.playback) extra.playback = { source: null, isPlaying: false, timestamp: 0 };
        await setSessionActive(groupId, true, extra);
      }
      latestSessionData = await getSession(groupId);
      watchMain.hidden = false;
      chatCtl.setMode("drawer");
      chatCtl.setOpen(true);
      callBar.classList.add("in-session");
      await applySessionData(latestSessionData);
    } catch (err) {
      console.error(err);
      alert("Couldn't start the call — check your camera/mic permissions and try again.");
    } finally {
      startBtn.disabled = false;
    }
  });

  document.getElementById("leave-session-btn").addEventListener("click", async () => {
    await call.leaveSession();
    if (currentMode) modules[currentMode]?.deactivate?.();
    currentMode = null;
    watchMain.hidden = true;
    chatCtl.setMode("full");
    callBar.classList.remove("in-session");
    document.getElementById("share-menu").hidden = true;
  });

  document.getElementById("back-btn").addEventListener("click", async () => {
    if (call.isInSession()) await call.leaveSession();
    location.href = "dashboard.html";
  });

  // ---- the "+" share picker ----
  const shareMenuBtn = document.getElementById("share-menu-btn");
  const shareMenu = document.getElementById("share-menu");
  shareMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    shareMenu.hidden = !shareMenu.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!shareMenu.hidden && !shareMenu.contains(e.target) && e.target !== shareMenuBtn) shareMenu.hidden = true;
  });
  shareMenu.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    const mode = btn.dataset.mode;
    shareMenu.hidden = true;
    if (mode === "screen") {
      const started = await call.startShare();
      if (!started) return; // user cancelled the share picker
    } else {
      call.stopScreenShare();
      await setMediaMode(groupId, mode, null);
    }
  });

  // ---- layout toggles: hide/show video tiles ----
  const toggleTilesBtn = document.getElementById("toggle-tiles-btn");
  let tilesHidden = false;
  toggleTilesBtn.addEventListener("click", () => {
    tilesHidden = !tilesHidden;
    callStrip.style.display = tilesHidden ? "none" : "flex";
    toggleTilesBtn.classList.toggle("is-on-glow", tilesHidden);
  });

  // ---- invite modal (link + QR) ----
  const dir = location.pathname.substring(0, location.pathname.lastIndexOf("/") + 1);
  const inviteUrl = `${location.origin}${dir}dashboard.html?join=${groupId}`;
  const inviteModal = document.getElementById("invite-modal");
  document.getElementById("invite-btn").addEventListener("click", () => {
    inviteModal.hidden = false;
    document.getElementById("invite-link-input").value = inviteUrl;
    const qrBox = document.getElementById("invite-qr");
    qrBox.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(inviteUrl)}" width="180" height="180" alt="QR code to join this group" />`;
  });
  document.getElementById("close-invite-btn").addEventListener("click", () => (inviteModal.hidden = true));
  inviteModal.addEventListener("click", (e) => {
    if (e.target === inviteModal) inviteModal.hidden = true;
  });
  document.getElementById("copy-invite-btn").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      e.target.textContent = "Copied!";
      setTimeout(() => (e.target.textContent = "Copy"), 1500);
    } catch {
      document.getElementById("invite-link-input").select();
    }
  });
}

main();
