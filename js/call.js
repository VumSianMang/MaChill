import { supabase } from "./supabase-config.js";
import { setMediaMode, setSessionActive } from "./playback-state.js";

// Google's free public STUN servers get most home/mobile networks connected
// directly. Strict corporate/campus networks may need a TURN relay added
// here too — see the README for free/cheap options.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export function initCall(groupId, user, { onRemoteScreenActive, onRemoteScreenEnded } = {}) {
  const strip = document.getElementById("call-strip");
  const micBtn = document.getElementById("mic-btn");
  const camBtn = document.getElementById("cam-btn");
  const screenVideo = document.getElementById("screen-video");

  const camPCs = new Map(); // otherUid -> RTCPeerConnection
  const screenPCs = new Map(); // otherUid -> RTCPeerConnection
  const channels = []; // realtime channels, torn down on leaveSession

  let localStream = null;
  let screenStream = null;
  let micOn = true;
  let camOn = true;
  let inSession = false;
  let knownMembers = new Set();

  function buildTile(id, { mirror }) {
    let tile = document.getElementById(id);
    if (tile) return tile;
    tile = document.createElement("div");
    tile.id = id;
    tile.className = "face-tile";
    tile.innerHTML = `<video ${mirror ? "" : 'style="transform:none"'} autoplay playsinline ${
      id === "tile-local" ? "muted" : ""
    }></video><span class="face-label"></span>`;
    strip.appendChild(tile);
    return tile;
  }

  async function startLocalMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      console.warn("Camera/mic unavailable — joining with audio/video off.", err);
      localStream = new MediaStream();
      micOn = false;
      camOn = false;
    }
    const tile = buildTile("tile-local", { mirror: true });
    tile.querySelector("video").srcObject = localStream;
    tile.querySelector(".face-label").textContent = "You";
    attachSpeakingDetector(localStream, tile);
    updateMicUI();
    updateCamUI();
  }

  function updateMicUI() {
    micBtn.classList.toggle("is-off", !micOn);
    micBtn.classList.toggle("is-on-glow", micOn);
  }
  function updateCamUI() {
    camBtn.classList.toggle("is-off", !camOn);
    camBtn.classList.toggle("is-on-glow", camOn);
  }
  micBtn.addEventListener("click", () => {
    micOn = !micOn;
    localStream?.getAudioTracks().forEach((t) => (t.enabled = micOn));
    updateMicUI();
  });
  camBtn.addEventListener("click", () => {
    camOn = !camOn;
    localStream?.getVideoTracks().forEach((t) => (t.enabled = camOn));
    updateCamUI();
  });

  // Simple active-speaker glow using the Web Audio API's volume meter.
  function attachSpeakingDetector(stream, tile) {
    if (!stream.getAudioTracks().length) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      (function loop() {
        if (!document.body.contains(tile)) return; // stop once the tile is gone
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        tile.classList.toggle("speaking", avg > 18);
        requestAnimationFrame(loop);
      })();
    } catch {
      /* nice-to-have, safe to skip if unsupported */
    }
  }

  // ---------------------------------------------------------------------
  // signaling: perfect negotiation over one `signals` row per pair+kind
  // ---------------------------------------------------------------------
  function attachSignaling(pc, otherUid, kind) {
    const pairKey = [user.uid, otherUid].sort().join("_");
    const channelKey = `${groupId}_${pairKey}_${kind}`;
    const polite = user.uid > otherUid;
    const myField = user.uid < otherUid ? "candidates_a" : "candidates_b";
    const theirField = myField === "candidates_a" ? "candidates_b" : "candidates_a";

    let makingOffer = false;
    let ignoreOffer = false;
    let appliedCount = 0;

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        await supabase.from("signals").upsert(
          { group_id: groupId, pair_key: pairKey, kind, offer: { sdp: pc.localDescription.sdp, type: pc.localDescription.type, from: user.uid } },
          { onConflict: "group_id,pair_key,kind" }
        );
      } catch (err) {
        console.error("negotiation failed", err);
      } finally {
        makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      supabase
        .rpc("append_candidate", {
          p_group_id: groupId,
          p_pair_key: pairKey,
          p_kind: kind,
          p_field: myField,
          p_candidate: candidate.toJSON(),
        })
        .then(({ error }) => error && console.error(error));
    };

    async function handleRow(data) {
      if (!data) return;

      if (data.offer && data.offer.from !== user.uid) {
        const collision = data.offer.type === "offer" && (makingOffer || pc.signalingState !== "stable");
        ignoreOffer = !polite && collision;
        if (ignoreOffer) return;
        try {
          if (collision) {
            await Promise.all([pc.setLocalDescription({ type: "rollback" }), pc.setRemoteDescription(data.offer)]);
          } else {
            await pc.setRemoteDescription(data.offer);
          }
          if (data.offer.type === "offer") {
            await pc.setLocalDescription();
            await supabase.from("signals").upsert(
              { group_id: groupId, pair_key: pairKey, kind, answer: { sdp: pc.localDescription.sdp, type: pc.localDescription.type, from: user.uid } },
              { onConflict: "group_id,pair_key,kind" }
            );
          }
        } catch (err) {
          console.error("offer handling failed", err);
        }
      }

      if (data.answer && data.answer.from !== user.uid && pc.signalingState === "have-local-offer") {
        try {
          await pc.setRemoteDescription(data.answer);
        } catch (err) {
          console.error("answer handling failed", err);
        }
      }

      const list = data[theirField] || [];
      for (const c of list.slice(appliedCount)) {
        try {
          await pc.addIceCandidate(c);
        } catch (err) {
          if (!ignoreOffer) console.error("ICE candidate failed", err);
        }
      }
      appliedCount = list.length;
    }

    // Initial state (handles joining mid-negotiation), then live updates.
    supabase
      .from("signals")
      .select("*")
      .eq("group_id", groupId)
      .eq("pair_key", pairKey)
      .eq("kind", kind)
      .maybeSingle()
      .then(({ data }) => handleRow(data));

    const channel = supabase
      .channel(`signal:${channelKey}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "signals", filter: `channel_key=eq.${channelKey}` },
        (payload) => handleRow(payload.new)
      )
      .subscribe();
    channels.push(channel);
  }

  function createCamConnection(otherUid, otherProfile) {
    if (camPCs.has(otherUid)) return camPCs.get(otherUid);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    camPCs.set(otherUid, pc);
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    const tile = buildTile(`tile-${otherUid}`, { mirror: false });
    tile.querySelector(".face-label").textContent = (otherProfile?.display_name || "Guest").split(" ")[0];

    pc.ontrack = (e) => {
      const v = tile.querySelector("video");
      if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
      attachSpeakingDetector(e.streams[0], tile);
    };
    pc.onconnectionstatechange = () => {
      tile.style.opacity = ["failed", "closed", "disconnected"].includes(pc.connectionState) ? "0.35" : "1";
    };

    attachSignaling(pc, otherUid, "cam");
    return pc;
  }

  function createScreenConnection(otherUid) {
    if (screenPCs.has(otherUid)) return screenPCs.get(otherUid);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    screenPCs.set(otherUid, pc);
    pc.ontrack = (e) => {
      screenVideo.srcObject = e.streams[0];
      onRemoteScreenActive?.();
      e.streams[0].getVideoTracks()[0]?.addEventListener("ended", () => onRemoteScreenEnded?.());
    };
    attachSignaling(pc, otherUid, "screen");
    return pc;
  }

  function removePeer(otherUid) {
    camPCs.get(otherUid)?.close();
    camPCs.delete(otherUid);
    screenPCs.get(otherUid)?.close();
    screenPCs.delete(otherUid);
    document.getElementById(`tile-${otherUid}`)?.remove();
  }

  // ---------------------------------------------------------------------
  // joining / leaving the watch session
  // ---------------------------------------------------------------------
  async function joinSession() {
    if (inSession) return;
    inSession = true;
    await startLocalMedia();

    await supabase.from("call_members").upsert(
      { group_id: groupId, user_id: user.uid, display_name: user.displayName || "Guest", avatar_url: user.photoURL || "" },
      { onConflict: "group_id,user_id" }
    );

    const { data: existing } = await supabase.from("call_members").select("*").eq("group_id", groupId);
    (existing || []).forEach((row) => {
      if (row.user_id === user.uid || knownMembers.has(row.user_id)) return;
      knownMembers.add(row.user_id);
      createCamConnection(row.user_id, row);
      if (screenStream) createScreenConnection(row.user_id);
    });

    const channel = supabase
      .channel(`callmembers:${groupId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "call_members", filter: `group_id=eq.${groupId}` },
        (payload) => {
          const uid = payload.new.user_id;
          if (uid === user.uid || knownMembers.has(uid)) return;
          knownMembers.add(uid);
          createCamConnection(uid, payload.new);
          if (screenStream) createScreenConnection(uid);
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "call_members", filter: `group_id=eq.${groupId}` },
        (payload) => {
          const uid = payload.old.user_id;
          if (!knownMembers.has(uid)) return;
          knownMembers.delete(uid);
          removePeer(uid);
        }
      )
      .subscribe();
    channels.push(channel);

    window.addEventListener("beforeunload", beforeUnloadHandler);
  }

  function beforeUnloadHandler() {
    supabase.from("call_members").delete().eq("group_id", groupId).eq("user_id", user.uid);
  }

  async function leaveSession() {
    if (!inSession) return;
    inSession = false;
    localStream?.getTracks().forEach((t) => t.stop());
    stopScreenShare();
    for (const pc of camPCs.values()) pc.close();
    camPCs.clear();
    knownMembers.forEach((uid) => document.getElementById(`tile-${uid}`)?.remove());
    knownMembers.clear();
    document.getElementById("tile-local")?.remove();
    channels.forEach((ch) => supabase.removeChannel(ch));
    channels.length = 0;
    window.removeEventListener("beforeunload", beforeUnloadHandler);

    try {
      await supabase.from("call_members").delete().eq("group_id", groupId).eq("user_id", user.uid);
      const { count } = await supabase
        .from("call_members")
        .select("*", { count: "exact", head: true })
        .eq("group_id", groupId);
      if (!count) await setSessionActive(groupId, false);
    } catch {
      /* best effort */
    }
  }

  // ---------------------------------------------------------------------
  // screen share ("Web together")
  // ---------------------------------------------------------------------
  async function startShare() {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      return false;
    }
    for (const uid of knownMembers) {
      const pc = createScreenConnection(uid);
      screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));
    }
    screenVideo.srcObject = screenStream; // sharer sees their own share too
    screenStream.getVideoTracks()[0].addEventListener("ended", () => stopScreenShare());
    await setMediaMode(groupId, "screen", user.uid);
    onRemoteScreenActive?.();
    return true;
  }

  function stopScreenShare() {
    if (!screenStream) return;
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
    if (screenVideo.srcObject) screenVideo.srcObject = null;
    for (const pc of screenPCs.values()) pc.close();
    screenPCs.clear();
    onRemoteScreenEnded?.();
  }

  return {
    joinSession,
    leaveSession,
    startShare,
    stopScreenShare,
    isInSession: () => inSession,
    isSharing: () => !!screenStream,
  };
}
