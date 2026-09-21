import { GOOGLE_OAUTH_CLIENT_ID } from "./supabase-config.js";
import { writePlayback, setMediaMode } from "./playback-state.js";

const DRIFT_TOLERANCE = 1.2;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

function extractFileId(input) {
  const raw = input.trim();
  const dMatch = raw.match(/\/d\/([a-zA-Z0-9_-]{15,})/);
  if (dMatch) return dMatch[1];
  try {
    const url = new URL(raw);
    const idParam = url.searchParams.get("id");
    if (idParam) return idParam;
  } catch {
    /* not a full URL */
  }
  if (/^[a-zA-Z0-9_-]{15,}$/.test(raw)) return raw;
  return null;
}

export function initDrive(groupId, user) {
  const video = document.getElementById("drive-video");
  const hint = document.getElementById("drive-hint");
  const linkInput = document.getElementById("drive-link-input");
  const shareBtn = document.getElementById("drive-share-btn");
  const fileList = document.getElementById("drive-file-list");

  const baseHint =
    'Set the file\'s Drive sharing to "Anyone with the link — Viewer" first. Whoever shares it downloads it now; everyone else gets their own full-quality copy straight from Drive — no live streaming, no buffering, no re-watching your data plan.';

  let tokenClient = null;
  let accessToken = null;
  let tokenExpiry = 0;
  let downloadedFileId = null;
  let applyingRemote = false;
  let latestRemote = null;
  let driftTimer = null;

  function ensureTokenClient() {
    if (tokenClient || !window.google?.accounts?.oauth2) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: () => {}, // overridden per-call below
    });
  }

  function getAccessToken() {
    return new Promise((resolve, reject) => {
      ensureTokenClient();
      if (!tokenClient) {
        reject(new Error("Google sign-in library hasn't loaded yet — try again in a second."));
        return;
      }
      if (accessToken && Date.now() < tokenExpiry) {
        resolve(accessToken);
        return;
      }
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(resp);
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
        resolve(accessToken);
      };
      tokenClient.requestAccessToken({ prompt: "" });
    });
  }

  async function fetchMeta(fileId, token) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Drive metadata request failed (${res.status})`);
    return res.json();
  }

  async function downloadFile(fileId, fileName, onProgress) {
    const token = await getAccessToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Couldn't download from Drive (${res.status}). Check the file's sharing settings.`);
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) onProgress(received / total);
    }
    return new Blob(chunks);
  }

  function playLoadedBlob(blob, fileId, fileName) {
    video.src = URL.createObjectURL(blob);
    video.style.display = "block";
    document.getElementById("stage-empty").style.display = "none";
    downloadedFileId = fileId;
    hint.textContent = `Playing "${fileName}", downloaded to this device. ` + baseHint;
    if (latestRemote && latestRemote.driveFileId === fileId) applyRemoteState(latestRemote);
  }

  // --- uploader: share a link ---
  shareBtn.addEventListener("click", async () => {
    const fileId = extractFileId(linkInput.value);
    if (!fileId) {
      alert("That doesn't look like a Google Drive share link.");
      return;
    }
    shareBtn.disabled = true;
    shareBtn.textContent = "Downloading…";
    try {
      const token = await getAccessToken();
      const meta = await fetchMeta(fileId, token);
      await setMediaMode(groupId, "drive");
      await writePlayback(groupId, user.uid, {
        source: "drive",
        driveFileId: fileId,
        driveFileName: meta.name,
        isPlaying: false,
        timestamp: 0,
      });
      const row = renderRow(fileId, meta.name);
      const blob = await downloadFile(fileId, meta.name, (p) => updateRowProgress(row, p));
      playLoadedBlob(blob, fileId, meta.name);
      row.remove();
    } catch (err) {
      console.error(err);
      alert(err.message || "Couldn't share that file — check it's shared as \"Anyone with the link\".");
    } finally {
      shareBtn.disabled = false;
      shareBtn.textContent = "Share with group";
    }
  });

  function renderRow(fileId, name) {
    const row = document.createElement("div");
    row.className = "drive-file-row";
    row.innerHTML = `<span>${escapeHtml(name)}</span><div style="flex:1;margin-left:10px;"><div class="drive-progress"><div style="width:0%"></div></div></div>`;
    fileList.appendChild(row);
    return row;
  }
  function updateRowProgress(row, fraction) {
    row.querySelector(".drive-progress > div").style.width = `${Math.round(fraction * 100)}%`;
  }

  // --- everyone else: offer a download when the group's drive file changes ---
  function offerDownload(playback) {
    fileList.innerHTML = "";
    if (downloadedFileId === playback.driveFileId) return;
    const row = renderRow(playback.driveFileId, playback.driveFileName);
    const btn = document.createElement("button");
    btn.className = "btn btn-glow";
    btn.textContent = "Download & watch";
    btn.style.marginTop = "8px";
    row.after(btn);
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Downloading…";
      try {
        const blob = await downloadFile(playback.driveFileId, playback.driveFileName, (p) =>
          updateRowProgress(row, p)
        );
        playLoadedBlob(blob, playback.driveFileId, playback.driveFileName);
        row.remove();
        btn.remove();
      } catch (err) {
        console.error(err);
        alert(err.message || "Download failed.");
        btn.disabled = false;
        btn.textContent = "Download & watch";
      }
    });
  }

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

  function applyRemoteState(playback) {
    if (!playback || playback.source !== "drive" || !playback.driveFileId) return;
    latestRemote = playback;
    if (downloadedFileId !== playback.driveFileId) {
      offerDownload(playback);
      return;
    }
    if (playback.updatedBy === user.uid) return;
    applyingRemote = true;
    const drift = Math.abs(video.currentTime - (playback.timestamp || 0));
    if (drift > DRIFT_TOLERANCE) video.currentTime = playback.timestamp || 0;
    if (playback.isPlaying && video.paused) video.play().catch(() => {});
    if (!playback.isPlaying && !video.paused) video.pause();
    setTimeout(() => (applyingRemote = false), 300);
  }

  function activate() {
    video.style.display = downloadedFileId ? "block" : "none";
    document.getElementById("stage-empty").style.display = downloadedFileId ? "none" : "block";
    if (driftTimer) clearInterval(driftTimer);
    driftTimer = setInterval(() => {
      if (downloadedFileId && !video.paused) {
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}
