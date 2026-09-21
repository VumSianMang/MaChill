import { supabase } from "./supabase-config.js";
import { EMOJI_SET } from "./emoji-data.js";

export function initChat(groupId, user) {
  const panel = document.getElementById("chat-panel");
  const toggleBtn = document.getElementById("chat-toggle-btn"); // only present once a session is active
  const closeBtn = document.getElementById("chat-close-btn");
  const log = document.getElementById("chat-log");
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send-btn");
  const emojiToggle = document.getElementById("emoji-toggle-btn");
  const emojiPicker = document.getElementById("emoji-picker");

  let mode = "full"; // "full" (main view) or "drawer" (side panel during a watch session)
  let isOpen = true;

  function render() {
    panel.classList.toggle("mode-full", mode === "full");
    panel.classList.toggle("mode-drawer", mode === "drawer");
    panel.classList.toggle("closed", mode === "drawer" && !isOpen);
    toggleBtn?.classList.remove("has-unread");
  }
  function setMode(next) {
    mode = next;
    if (mode === "full") isOpen = true;
    render();
  }
  function setOpen(open) {
    isOpen = open;
    render();
    if (open) input.focus();
  }
  render();

  toggleBtn?.addEventListener("click", () => setOpen(!isOpen));
  closeBtn.addEventListener("click", () => setOpen(false));

  // --- emoji picker ---
  emojiPicker.innerHTML = EMOJI_SET.map((e) => `<button type="button">${e}</button>`).join("");
  emojiPicker.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + btn.textContent + input.value.slice(end);
    const newPos = start + btn.textContent.length;
    input.setSelectionRange(newPos, newPos);
    input.focus();
  });
  emojiToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    emojiPicker.hidden = !emojiPicker.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!emojiPicker.hidden && !emojiPicker.contains(e.target) && e.target !== emojiToggle) {
      emojiPicker.hidden = true;
    }
  });

  // --- rendering ---
  function appendMessage(m) {
    const mine = m.user_id === user.uid;
    const row = document.createElement("div");
    row.className = "chat-msg" + (mine ? " mine" : "");
    row.innerHTML = `
      ${mine ? "" : `<img class="avatar" src="${m.photo_url || ""}" alt="" />`}
      <div class="bubble-col">
        ${mine ? "" : `<div class="who">${escapeHtml(m.name || "Guest")}</div>`}
        <div class="bubble">${escapeHtml(m.text || "")}</div>
      </div>`;
    log.appendChild(row);
    if (!mine && mode === "drawer" && !isOpen) toggleBtn?.classList.add("has-unread");
  }

  // --- sending ---
  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const { error } = await supabase.from("group_messages").insert({
      group_id: groupId,
      user_id: user.uid,
      name: user.displayName || "Guest",
      photo_url: user.photoURL || "",
      text,
    });
    if (error) console.error(error);
  }
  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });

  // --- receiving: load saved history once, then stream new messages live ---
  (async () => {
    const { data, error } = await supabase
      .from("group_messages")
      .select("*")
      .eq("group_id", groupId)
      .order("created_at")
      .limit(200);
    if (error) console.error(error);
    (data || []).forEach(appendMessage);
    log.scrollTop = log.scrollHeight;
  })();

  supabase
    .channel(`chat:${groupId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "group_messages", filter: `group_id=eq.${groupId}` },
      (payload) => {
        appendMessage(payload.new);
        log.scrollTop = log.scrollHeight;
      }
    )
    .subscribe();

  return { setMode, setOpen, isOpen: () => isOpen };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
