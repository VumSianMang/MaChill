import { writePlayback, setMediaMode } from "./playback-state.js";

const DRIFT_TOLERANCE = 1.5; // seconds of slack before we force a re-seek

function extractVideoId(input) {
  const raw = input.trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.hostname.includes("youtu.be")) return url.pathname.slice(1);
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    const embedMatch = url.pathname.match(/\/embed\/([\w-]{11})/);
    if (embedMatch) return embedMatch[1];
  } catch {
    /* not a URL, fall through */
  }
  const match = raw.match(/([\w-]{11})/);
  return match ? match[1] : null;
}

export function initYouTubeSync(groupId, user) {
  let player = null;
  let playerReady = false;
  let applyingRemote = false;
  let currentLoadedId = null;
  let driftTimer = null;

  const ytReady = new Promise((resolve) => {
    if (window.YT && window.YT.Player) resolve();
    else window.onYouTubeIframeAPIReady = resolve;
  });

  ytReady.then(() => {
    player = new YT.Player("yt-player", {
      host: "https://www.youtube.com",
      playerVars: { playsinline: 1, rel: 0 },
      events: {
        onReady: () => (playerReady = true),
        onStateChange: onPlayerStateChange,
      },
    });
  });

  function onPlayerStateChange(e) {
    if (applyingRemote) return;
    if (e.data === YT.PlayerState.PLAYING) {
      writePlayback(groupId, user.uid, { isPlaying: true, timestamp: player.getCurrentTime() });
    } else if (e.data === YT.PlayerState.PAUSED) {
      writePlayback(groupId, user.uid, { isPlaying: false, timestamp: player.getCurrentTime() });
    }
  }

  // Load button — anyone in the group can queue a video for everyone.
  const urlInput = document.getElementById("youtube-url-input");
  const loadBtn = document.getElementById("youtube-load-btn");
  loadBtn.addEventListener("click", async () => {
    const id = extractVideoId(urlInput.value);
    if (!id) {
      alert("That doesn't look like a YouTube link or video ID.");
      return;
    }
    await setMediaMode(groupId, "youtube");
    await writePlayback(groupId, user.uid, {
      source: "youtube",
      youtubeId: id,
      isPlaying: true,
      timestamp: 0,
    });
  });

  function applyRemoteState(playback) {
    if (!playback || playback.source !== "youtube" || !playback.youtubeId) return;
    if (!playerReady || playback.updatedBy === user.uid) return;

    applyingRemote = true;
    if (playback.youtubeId !== currentLoadedId) {
      currentLoadedId = playback.youtubeId;
      player.loadVideoById({ videoId: playback.youtubeId, startSeconds: playback.timestamp || 0 });
      if (!playback.isPlaying) setTimeout(() => player.pauseVideo(), 400);
    } else {
      const drift = Math.abs(player.getCurrentTime() - (playback.timestamp || 0));
      if (drift > DRIFT_TOLERANCE) player.seekTo(playback.timestamp || 0, true);
      const state = player.getPlayerState();
      if (playback.isPlaying && state !== YT.PlayerState.PLAYING) player.playVideo();
      if (!playback.isPlaying && state === YT.PlayerState.PLAYING) player.pauseVideo();
    }
    setTimeout(() => (applyingRemote = false), 350);
  }

  function activate() {
    document.getElementById("yt-player").style.display = "block";
    document.getElementById("stage-empty").style.display = currentLoadedId ? "none" : "block";
    if (driftTimer) clearInterval(driftTimer);
    // Gentle periodic correction so late joiners / clock drift settle out.
    driftTimer = setInterval(() => {
      if (playerReady && player.getPlayerState() === 1) {
        writePlayback(groupId, user.uid, { timestamp: player.getCurrentTime() }).catch(() => {});
      }
    }, 6000);
  }

  function deactivate() {
    document.getElementById("yt-player").style.display = "none";
    if (driftTimer) clearInterval(driftTimer);
    if (playerReady) player.pauseVideo();
  }

  return { applyRemoteState, activate, deactivate };
}
