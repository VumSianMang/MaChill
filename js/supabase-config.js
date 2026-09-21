// ============================================================================
// MaChill — Supabase setup
//
// 1. Go to https://supabase.com/dashboard → New project (free tier is
//    enough).
// 2. SQL Editor → New query → paste the entire contents of
//    supabase-schema.sql from this repo → Run.
// 3. Authentication → Providers → Google → toggle it on. You'll need a
//    Google OAuth Client ID + Secret (Google Cloud Console → APIs &
//    Services → Credentials) — paste both into Supabase, and copy the
//    "Callback URL (for OAuth)" Supabase shows you.
// 4. Back in Google Cloud Console, on that same OAuth client, add:
//      - Authorized redirect URI: the callback URL Supabase gave you
//      - Authorized JavaScript origin: https://yourname.github.io
//        (and http://localhost:xxxx for local testing)
//    This one Google OAuth client is reused for Drive access too (step 6),
//    so it needs both the redirect URI above AND the JS origin.
// 5. Project Settings → API → copy "Project URL" and the "anon public" key
//    into SUPABASE_URL / SUPABASE_ANON_KEY below.
// 6. Same OAuth client's Client ID also goes into GOOGLE_OAUTH_CLIENT_ID
//    below — that one is used separately, only when someone opens Drive
//    mode, to get Drive-read permission (kept separate from sign-in so
//    people aren't asked for Drive access just to log in).
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://isflmikuqxvsfesayhnl.supabase.co/rest/v1/";
const SUPABASE_ANON_KEY = "https://isflmikuqxvsfesayhnl.supabase.co/rest/v1/";

export const GOOGLE_OAUTH_CLIENT_ID = "950121074804-tc9571idiahrvt469e7a93epokduoudq.apps.googleusercontent.com";
export const GOOGLE_API_KEY = "950121074804-tc9571idiahrvt469e7a93epokduoudq.apps.googleusercontent.com"; // unused today, kept for a future Drive Picker upgrade

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
