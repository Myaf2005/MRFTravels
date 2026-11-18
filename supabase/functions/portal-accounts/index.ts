// MRF Travels — portal-accounts
// The only place that can create or change client logins. Runs inside Supabase with the
// secret key, so the key never reaches a browser.
//
// Actions (POST JSON { action, ... } with the signed-in user's token):
//   invite     advisor only — create a temporary login for a client and add them to a trip
//   reset      advisor only — give an existing client a new temporary login
//   remove     advisor only — delete a client login
//   set_login  the client themself, first sign-in only — choose their own username + password

import { createClient } from "npm:@supabase/supabase-js@2";

const CLIENT_DOMAIN = "clients.mrftravels.com"; // usernames become <username>@clients.mrftravels.com behind the scenes
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Supabase provides the secret key to functions automatically (newer projects as SUPABASE_SECRET_KEYS).
function secretKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return keys.default || (Object.values(keys)[0] as string);
  } catch {
    throw new Error("No secret key available to the function");
  }
}

const admin = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function claims(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
  } catch {
    return {};
  }
}

function tempPassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function slug(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
}

async function freeUsername(base: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = `${base}.${Math.floor(1000 + Math.random() * 9000)}`;
    const { data } = await admin.from("profiles").select("id").eq("username", candidate).maybeSingle();
    if (!data) return candidate;
  }
  throw new Error("Could not find a free username");
}

const USERNAME_RE = /^(?=.*[a-z0-9])[a-z0-9._-]{3,30}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Please sign in again." }, 401);
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "Please sign in again." }, 401);
  const me = who.user;

  const { data: myProfile } = await admin.from("profiles").select("role, must_set_login").eq("id", me.id).single();
  const isAdvisor = myProfile?.role === "advisor" && claims(token).aal === "aal2";

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  try {
    switch (body.action) {
      case "invite": {
        if (!isAdvisor) return json({ error: "Only the advisor can invite clients." }, 403);
        const first = (body.first_name || "").trim();
        const last = (body.last_name || "").trim();
        const tripId = body.trip_id;
        if (!first || !last || !tripId) return json({ error: "Name and trip are required." }, 400);
        const username = await freeUsername(`${slug(first)}.${slug(last)}` || "client");
        const password = tempPassword();
        const { data: created, error } = await admin.auth.admin.createUser({
          email: `${username}@${CLIENT_DOMAIN}`,
          password,
          email_confirm: true,
          user_metadata: { full_name: `${first} ${last}`, username },
        });
        if (error) throw error;
        const uid = created.user.id;
        await admin.from("profiles").update({
          contact_email: (body.contact_email || "").trim() || null,
          must_set_login: true,
          full_name: `${first} ${last}`,
          username,
        }).eq("id", uid);
        const { error: memErr } = await admin.from("trip_members").insert({ trip_id: tripId, user_id: uid });
        if (memErr) throw memErr;
        return json({ user_id: uid, username, password });
      }

      case "reset": {
        if (!isAdvisor) return json({ error: "Only the advisor can reset logins." }, 403);
        const uid = body.user_id;
        const { data: p } = await admin.from("profiles").select("full_name, role").eq("id", uid).single();
        if (!p || p.role !== "client") return json({ error: "Client not found." }, 404);
        const [first = "client", ...rest] = (p.full_name || "client").split(" ");
        const username = await freeUsername(`${slug(first)}.${slug(rest.join("")) || "client"}`);
        const password = tempPassword();
        const { error } = await admin.auth.admin.updateUserById(uid, {
          email: `${username}@${CLIENT_DOMAIN}`, password, email_confirm: true,
        });
        if (error) throw error;
        await admin.from("profiles").update({ username, must_set_login: true }).eq("id", uid);
        return json({ username, password });
      }

      case "remove": {
        if (!isAdvisor) return json({ error: "Only the advisor can remove clients." }, 403);
        const uid = body.user_id;
        const { data: p } = await admin.from("profiles").select("role").eq("id", uid).single();
        if (!p || p.role !== "client") return json({ error: "Client not found." }, 404);
        const { error } = await admin.auth.admin.deleteUser(uid);
        if (error) throw error;
        return json({ ok: true });
      }

      case "set_login": {
        if (!myProfile?.must_set_login) return json({ error: "Your login is already set." }, 400);
        const username = (body.username || "").trim().toLowerCase().replace(/\s+/g, ".");
        const password = body.password || "";
        if (!USERNAME_RE.test(username)) {
          return json({ error: "Pick a username of at least 3 letters or numbers." }, 400);
        }
        if (password.length < 6) {
          return json({ error: "Your password needs at least 6 characters." }, 400);
        }
        const { data: taken } = await admin.from("profiles").select("id").eq("username", username).neq("id", me.id).maybeSingle();
        if (taken) return json({ error: "That username is taken. Try another." }, 409);
        const { error } = await admin.auth.admin.updateUserById(me.id, {
          email: `${username}@${CLIENT_DOMAIN}`, password, email_confirm: true,
        });
        if (error) throw error;
        await admin.from("profiles").update({ username, must_set_login: false }).eq("id", me.id);
        return json({ ok: true, username });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
