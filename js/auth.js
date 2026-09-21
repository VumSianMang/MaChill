import { supabase } from "./supabase-config.js";

const path = location.pathname.split("/").pop() || "index.html";
const dir = location.pathname.substring(0, location.pathname.lastIndexOf("/") + 1);

function redirectTarget(page) {
  return `${location.origin}${dir}${page}`;
}

// Keep the profile row's name/photo in sync with Google in case they change
// (the row itself, plus its MaChill ID, is created by a database trigger on
// first sign-in — see supabase-schema.sql).
async function refreshProfile(user) {
  const meta = user.user_metadata || {};
  await supabase
    .from("profiles")
    .update({
      display_name: meta.full_name || meta.name || "Guest",
      avatar_url: meta.avatar_url || null,
    })
    .eq("id", user.id);
}

async function route(session) {
  if (session?.user) {
    refreshProfile(session.user).catch(() => {});
    if (path === "index.html" || path === "") location.href = redirectTarget("dashboard.html");
  } else {
    if (path !== "index.html" && path !== "") location.href = redirectTarget("index.html");
  }
}

supabase.auth.getSession().then(({ data }) => route(data.session));
supabase.auth.onAuthStateChange((_event, session) => route(session));

const signInBtn = document.getElementById("google-signin-btn");
if (signInBtn) {
  signInBtn.addEventListener("click", async () => {
    signInBtn.disabled = true;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectTarget("dashboard.html") },
    });
    if (error) {
      console.error(error);
      signInBtn.disabled = false;
      alert("Sign-in didn't go through — mind trying again?");
    }
    // On success the page navigates to Google, then back — no further code
    // here runs until then.
  });
}

document.querySelectorAll("[data-sign-out]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    await supabase.auth.signOut();
    location.href = redirectTarget("index.html");
  });
});
