import { writePlayback, setMediaMode } from "./playback-state.js";

const DRIFT_TOLERANCE = 1.2;

export function initLocalSync(groupId, user) {
  const video = document.getElementById("local-video");
  const hint = document.getElementById("local-hint");
  const pickBtn = document.getElementById("local-file-btn");

  let fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "video/*";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);

  let loadedName = null;
  let applyingRemote = false;
  let latestRemote = null; // last playback we received, so we can react once a matching file loads
  let driftTimer = null;
  const baseHint =
    "Nothing is uploaded — the file stays on your device. If everyone opens the same file (same name), MaChill just keeps your play position, pause, and seeking in sync using tiny timestamp pings, so there's no streaming and no data usage from the video itself.";

  pickBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    loadedName = file.name;
    video.src = URL.createObjectURL(file);
    video.style.display = "block";
    document.getElementById("stage-empty").style.display = "none";
    hint.textContent = `Playing "${file.name}" on this device. ` + baseHint;

    await setMediaMode(groupId, "local");
    await writePlayback(groupId, user.uid, {
      source: "local",
      localName: file.name,
      isPlaying: false,
      timestamp: 0,
    });

    // If someone was already mid-movie when we opened our copy, jump to them.
    if (latestRemote && sameName(latestRemote.localName, loadedName)) {
      applyRemoteState(latestRemote);
    }
  });

  video.addEventListener("play", () => {
    if (applyingRemote) return;
    writePlayback(groupId, user.uid, { isPlaying: true, timestamp: video.currentTime });
  });
  video.addEventListener("pause", () => {
    if (applyingRemote) return;
    writePlayback(groupId, user.uid, { isPlaying: false, timestamp: video.currentTime });
  });
  video.addEventListener("seeked", () => {
    if (applyingRemote) return;
    writePlayback(groupId, user.uid, { timestamp: video.currentTime });
  });

  function sameName(a, b) {
    return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
  }

  function applyRemoteState(playback) {
    if (!playback || playback.source !== "local") return;
    latestRemote = playback;
    if (playback.updatedBy === user.uid) return;

    if (!loadedName) {
      hint.textContent = `Open the file named "${playback.localName || "?"}" on your device to sync up. ` + baseHint;
      return;
    }
    if (!sameName(loadedName, playback.localName)) {
      hint.textContent = `Heads up — you opened "${loadedName}" but the group is watching "${playback.localName}". Open the matching file to sync.`;
      return;
    }

    applyingRemote = true;
    const drift = Math.abs(video.currentTime - (playback.timestamp || 0));
    if (drift > DRIFT_TOLERANCE) video.currentTime = playback.timestamp || 0;
    if (playback.isPlaying && video.paused) video.play().catch(() => {});
    if (!playback.isPlaying && !video.paused) video.pause();
    setTimeout(() => (applyingRemote = false), 300);
  }

  function activate() {
    video.style.display = "block";
    document.getElementById("stage-empty").style.display = loadedName ? "none" : "block";
    if (driftTimer) clearInterval(driftTimer);
    driftTimer = setInterval(() => {
      if (loadedName && !video.paused) {
        writePlayback(groupId, user.uid, { timestamp: video.currentTime }).catch(() => {});
      }
    }, 6000);
  }

  function deactivate() {
    video.style.display = "none";
    if (driftTimer) clearInterval(driftTimer);
    video.pause();
  }

  return { applyRemoteState, activate, deactivate };
}
