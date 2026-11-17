// MRF Travels — client portal
import { sb, $, esc, askConfirm, fmt, fmtLong, daysUntil, money, initials, toast, openDocument, uploadFile, callAccounts,
  loginEmail, setRemember, getRemember, CATEGORIES, KIND_TAG, ADVISOR, BUCKET, toDate, slidesHtml, nextCoverPhoto, photoStyle } from "./lib.js?v=202611171645";

const app = $("#app");
const S = {
  screen: "loading", profile: null, trips: [], tripId: null, d: null,
  section: "overview", day: 0, filter: "all", updFilter: "all", showForgot: false, error: "", busy: false,
};

const ICON_DOC = `<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8A6A38" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 20px"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>`;
const BRAND = `<a class="logo" href="/"><b>MRF</b><span>Travels</span></a>`;

// ---------------- boot ----------------
async function boot() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return show("signin");
  await afterSignIn();
}

async function afterSignIn() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return show("signin");
  const { data: profile } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (!profile) { await sb.auth.signOut(); return show("signin", "This login isn't set up yet. Please contact Mya."); }
  if (profile.role === "advisor") {
    const pid = new URLSearchParams(location.search).get("preview");
    if (!pid) { location.href = "studio/"; return; }
    return startPreview(profile, pid);
  }
  S.profile = profile;
  if (profile.must_set_login) return show("setup");
  await loadTrips();
  show("portal");
}

// Mya previewing a client's portal from the Studio: same screens, but nothing is saved.
async function startPreview(advisor, tripId) {
  const { data: all } = await sb.from("trips").select("*").order("start_date", { ascending: true });
  if (!(all || []).some((t) => t.id === tripId)) { location.href = "studio/"; return; }
  const { data: members } = await sb.from("trip_members").select("*");
  const { data: profiles } = await sb.from("profiles").select("id,full_name,role");
  const clientIds = (members || []).filter((m) => m.trip_id === tripId).map((m) => m.user_id);
  const clients = (profiles || []).filter((p) => clientIds.includes(p.id));
  const first = clients[0];
  const trip = all.find((t) => t.id === tripId);
  S.preview = {
    advisor, clients,
    all: all.map((t) => ({ id: t.id, label: (t.travelers || (members || []).filter((m) => m.trip_id === t.id).map((m) => (profiles || []).find((p) => p.id === m.user_id)?.full_name).filter(Boolean).join(" & ") || t.title) + " · " + t.title })),
  };
  // what this client would see: the trips they belong to (or just this one if no login yet)
  S.profile = first ? { ...first } : { id: null, full_name: trip.travelers || "Your client" };
  S.trips = first ? all.filter((t) => (members || []).some((m) => m.user_id === first.id && m.trip_id === t.id)) : [trip];
  S.tripId = tripId; S.section = "overview";
  await loadTrip();
  show("portal");
}
const previewBlock = (what) => { toast(`Preview: ${what} only works for the client. Nothing was changed.`); };
function previewBar() {
  if (!S.preview) return "";
  const names = S.preview.clients.map((c) => c.full_name).join(" & ") || "this trip (no client login yet)";
  return `<div class="preview-bar noprint" role="region" aria-label="Preview"><div class="in">
    <span><b>Preview</b> · Viewing as ${esc(names)}. Nothing you click here changes their trip.</span>
    <span style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label class="sr" for="pv-pick">Switch client</label>
    <select id="pv-pick" class="input" data-change="previewSwitch">${S.preview.all.map((t) => `<option value="${t.id}" ${t.id === S.tripId ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select>
    <a class="btn gold sm" href="studio/">Back to Studio</a></span></div></div>`;
}

async function loadTrips() {
  const { data: trips } = await sb.from("trips").select("*").order("start_date", { ascending: true });
  S.trips = trips || [];
  let saved; try { saved = localStorage.getItem("mrf-trip"); } catch {}
  const upcoming = S.trips.find((t) => (daysUntil(t.end_date) ?? 0) >= 0);
  S.tripId = (S.trips.find((t) => t.id === saved) || upcoming || S.trips[0] || {}).id || null;
  if (S.tripId) await loadTrip();
}

async function loadTrip() {
  const id = S.tripId;
  const q = (t, order = "sort") => sb.from(t).select("*").eq("trip_id", id).order(order);
  const [days, items, bookings, docs, payments, updates, checklist] = await Promise.all([
    q("itinerary_days"), q("itinerary_items"), q("bookings"), q("documents", "created_at"), q("payments"),
    sb.from("updates").select("*").eq("trip_id", id).order("created_at", { ascending: false }), q("checklist_items"),
  ]);
  const updIds = (updates.data || []).map((u) => u.id);
  let rq = sb.from("update_reads").select("update_id").in("update_id", updIds);
  if (S.preview) rq = rq.eq("user_id", S.profile.id || "00000000-0000-0000-0000-000000000000");
  const reads = updIds.length ? await rq : { data: [] };
  const daysSorted = (days.data || []).sort((a, b) => (a.day_date || "").localeCompare(b.day_date || "") || a.sort - b.sort);
  S.d = {
    days: daysSorted.map((d) => ({ ...d, items: (items.data || []).filter((i) => i.day_id === d.id).sort((a, b) => a.sort - b.sort) })),
    bookings: bookings.data || [], docs: docs.data || [], payments: payments.data || [],
    updates: updates.data || [], read: new Set((reads.data || []).map((r) => r.update_id)), checklist: checklist.data || [],
  };
  if (S.day >= S.d.days.length) S.day = 0;
}

function show(screen, error = "") { S.screen = screen; S.error = error; render(); }
const trip = () => S.trips.find((t) => t.id === S.tripId);
const doc = (id) => S.d?.docs.find((x) => x.id === id);

// ---------------- render ----------------
function render() {
  if (S.screen === "signin") app.innerHTML = viewSignIn();
  else if (S.screen === "setup") app.innerHTML = viewSetup();
  else if (S.screen === "portal") app.innerHTML = viewPortal();
  else app.innerHTML = `<div class="loading">Loading…</div>`;
  document.title = (S.screen === "portal" ? "My trip" : "Client Portal") + " | MRF Travels";
}

function viewSignIn() {
  return `<div class="signin">
  <div class="hero">${slidesHtml()}${BRAND}
    <div class="copy"><p class="eyebrow">Client portal</p>
      <h1>Everything for your journey, <em>in one place.</em></h1>
      <p>Your itinerary, confirmations and documents, curated and kept up to date by your advisor.</p></div>
    <p class="foot">Bespoke luxury travel</p></div>
  <div class="pane"><form id="f-signin" novalidate>
    <div><h2 style="font-size:40px">Welcome</h2><p class="muted" style="margin-top:6px">Sign in to see your trip.</p></div>
    <div class="field"><label for="u">Username</label><input class="input" id="u" name="u" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(S.lastUser || "")}" required></div>
    <div class="field"><label for="p">Password</label><input class="input" id="p" name="p" type="password" autocomplete="current-password" required></div>
    ${S.error ? `<p class="alert" role="alert">${esc(S.error)}</p>` : ""}
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <label class="check"><input type="checkbox" name="remember" ${getRemember() ? "checked" : ""}> Keep me signed in</label>
      <button type="button" class="linkbtn" data-act="forgot" aria-expanded="${S.showForgot}">Forgot password?</button></div>
    ${S.showForgot ? `<p class="note">For your security, password resets go through Mya. Send her a text or WhatsApp at ${esc(ADVISOR.phoneShown)} and she'll send you a fresh temporary login.</p>` : ""}
    <button class="btn" type="submit" ${S.busy ? "disabled" : ""}>${S.busy ? "Signing in…" : "Sign in"}</button>
    <div style="height:1px;background:var(--line)"></div>
    <div><p class="eyebrow" style="font-size:12px">New client?</p>
      <p class="muted" style="font-size:15px;margin-top:6px">After your first consultation, Mya sends you a private temporary login. Use it once here, then choose your own username and password.</p></div>
  </form></div></div>`;
}

function viewSetup() {
  return `<div class="centered photo"><form class="panel-card" id="f-setup" novalidate>
    ${BRAND}
    <div><p class="eyebrow">Welcome, ${esc((S.profile?.full_name || "").split(" ")[0])}</p>
      <h2 style="font-size:38px;margin-top:8px">Make it yours</h2>
      <p class="muted" style="margin-top:8px">Your temporary login worked. Now choose a username and password only you know. The temporary one stops working once you save.</p></div>
    <div class="field"><label for="nu">New username</label><input class="input" id="nu" name="nu" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
    <div class="field"><label for="np">New password</label><input class="input" id="np" name="np" type="password" autocomplete="new-password" required>
      <p class="muted small" style="margin-top:6px">At least 10 characters, including a number or symbol.</p></div>
    <div class="field"><label for="np2">Confirm password</label><input class="input" id="np2" name="np2" type="password" autocomplete="new-password" required></div>
    ${S.error ? `<p class="alert" role="alert">${esc(S.error)}</p>` : ""}
    <button class="btn" type="submit" ${S.busy ? "disabled" : ""}>${S.busy ? "Saving…" : "Save and enter my trip"}</button>
    <button class="linkbtn" type="button" data-act="signout" style="align-self:center">Cancel</button>
  </form></div>`;
}

const SECTIONS = [["overview", "Overview"], ["itinerary", "Itinerary"], ["bookings", "Reservations"], ["documents", "Documents"],
  ["costs", "Trip costs"], ["essentials", "Before you go"], ["updates", "Updates & reminders"]];

function viewPortal() {
  const t = trip();
  const unread = S.d ? S.d.updates.filter((u) => !S.d.read.has(u.id)).length : 0;
  const header = previewBar() + `<header class="top"><div class="in">${BRAND}<div class="r">
    ${S.trips.length > 1 ? `<label class="sr" for="trip-pick">Choose a trip</label><select id="trip-pick" class="input" style="width:auto;min-height:44px;font-size:15px" data-change="trip">${S.trips.map((x) => `<option value="${x.id}" ${x.id === S.tripId ? "selected" : ""}>${esc(x.title)}</option>`).join("")}</select>` : ""}
    ${t ? `<button class="icon-btn" type="button" data-act="go" data-v="updates" aria-label="Updates${unread ? `, ${unread} unread` : ""}"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>${unread ? `<span class="count">${unread}</span>` : ""}</button>` : ""}
    <span class="avatar" aria-hidden="true">${esc(initials(S.profile.full_name))}</span><span>${esc(S.profile.full_name)}</span>
    <button class="btn line sm" type="button" data-act="signout">Sign out</button></div></div></header>`;
  if (!t) {
    return header + `<div class="centered" style="min-height:60vh"><div class="panel-card" style="text-align:center;align-items:center">
      <h2 style="font-size:34px">Your trip is being prepared</h2><p class="muted">Mya is building your itinerary. You'll see everything here as soon as it's ready.</p></div></div>`;
  }
  const nav = SECTIONS.map(([k, l]) => `<button class="nav" type="button" data-act="go" data-v="${k}" ${S.section === k ? 'aria-current="page"' : ""}>${l}${k === "updates" && unread ? `<span class="count">${unread}</span>` : ""}</button>`).join("");
  const body = { overview: secOverview, itinerary: secItinerary, bookings: secBookings, documents: secDocuments,
    costs: secCosts, essentials: secEssentials, updates: secUpdates }[S.section]();
  return header + `<div class="shell"><nav class="side noprint" aria-label="Trip sections">${nav}
    <div class="advisor-card"><p class="eyebrow">Your advisor</p><p class="name">${esc(ADVISOR.name)}</p>
      <p>WhatsApp when you're abroad. Call or text within the US.</p>
      <button class="linkbtn" type="button" data-act="go" data-v="essentials">How to reach me</button></div></nav>
    <main class="main" id="main">${body}</main></div>`;
}

function head(eyebrow, title, right = "", sub = "") {
  return `<div class="head"><div class="t"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ""}</div>${right}</div>`;
}
const datesLine = (t) => {
  if (!t.start_date) return "";
  const nights = t.end_date ? Math.round((toDate(t.end_date) - toDate(t.start_date)) / 86400000) : 0;
  return `${fmt(t.start_date, { month: "long", day: "numeric" })}${t.end_date ? " – " + fmt(t.end_date, { month: "long", day: "numeric", year: "numeric" }) : ""}${nights ? ` · ${nights} night${nights === 1 ? "" : "s"}` : ""}`;
};
const statusBadge = (s) => `<span class="badge ${s === "Confirmed" ? "ok" : "wait"}">${esc(s)}</span>`;

function secOverview() {
  const t = trip(), d = S.d;
  const dd = daysUntil(t.start_date);
  const confirmed = d.bookings.filter((b) => b.status === "Confirmed").length;
  const next = d.payments.filter((p) => !p.received).sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""))[0];
  const done = d.checklist.filter((c) => c.done).length;
  const first = d.days.slice(0, 3);
  return `<section class="banner"><div style="flex:1 1 360px;display:flex;flex-direction:column;gap:14px">
      <p class="eyebrow">${esc(datesLine(t).toUpperCase())}</p><h1>${esc(t.title)}</h1><p>${esc(t.travelers)}</p></div>
      <div style="display:flex;flex-direction:column;gap:18px;align-items:flex-end">${dd !== null && dd >= 0 ? `<div class="days"><b>${dd}</b><span>${dd === 1 ? "DAY" : "DAYS"} TO GO</span></div>` : ""}
      <button class="btn gold sm noprint" type="button" data-act="pdf">Download itinerary (PDF)</button></div></section>
    <div class="grid">
      <button class="card stat" type="button" data-act="go" data-v="bookings"><span class="k">Reservations</span><span class="n">${confirmed} of ${d.bookings.length}</span><span class="muted small">confirmed</span></button>
      <button class="card stat" type="button" data-act="go" data-v="costs"><span class="k">Next due date</span><span class="n">${next ? esc(fmt(next.due_date, { month: "short", day: "numeric" })) : "—"}</span><span class="muted small">${next ? `${esc(next.name)} · ${money(next.amount)}` : "Nothing due"}</span></button>
      <button class="card stat" type="button" data-act="go" data-v="essentials"><span class="k">Before you go</span><span class="n">${done} of ${d.checklist.length}</span><span class="muted small">checklist items done</span></button>
    </div>
    <div class="split"><section class="card a"><div class="head" style="margin-bottom:10px"><h2 style="font-size:28px">Your first days</h2><button class="linkbtn" type="button" data-act="go" data-v="itinerary">Full itinerary</button></div>
      ${first.length ? first.map((day, i) => `<button class="rowbtn" type="button" data-act="day" data-v="${i}">${dateBox(day, i)}
        <span><span class="nm" style="font-size:17px;font-weight:400;display:block">${esc(day.title)}</span><span class="muted small">${esc(day.place)}</span></span></button>`).join("") : `<p class="empty">Your itinerary will appear here soon.</p>`}</section>
      <section class="card b"><div class="head" style="margin-bottom:4px"><h2 style="font-size:28px">From Mya</h2><button class="linkbtn" type="button" data-act="go" data-v="updates">See all</button></div>
      ${d.updates.length ? d.updates.slice(0, 3).map(updateRow).join("") : `<p class="empty">No updates yet.</p>`}</section></div>`;
}

function dateBox(day, i) {
  if (day.day_date) {
    const dt = toDate(day.day_date);
    return `<span class="datebox"><small>${dt.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()}</small><b>${dt.getDate()}</b></span>`;
  }
  return `<span class="datebox"><small>DAY</small><b>${i + 1}</b></span>`;
}

function secItinerary() {
  const days = S.d.days;
  if (!days.length) return head("Itinerary", "Day by day") + `<div class="card"><p class="muted">Mya is building your day-by-day plan. It will appear here as soon as it's ready.</p></div>`;
  const day = days[S.day];
  const dt = day.day_date ? toDate(day.day_date) : null;
  const label = `Day ${S.day + 1}${dt ? " · " + dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : ""}`;
  return head("Itinerary", "Day by day", `<button class="btn sm noprint" type="button" data-act="pdf">Download itinerary (PDF)</button>`) +
    `<div class="chips noprint" role="group" aria-label="Choose a day">${days.map((d, i) => {
      const x = d.day_date ? toDate(d.day_date) : null;
      return `<button class="chip" type="button" data-act="day" data-v="${i}" aria-pressed="${i === S.day}"><small>${x ? x.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase() : "DAY"}</small><b>${x ? x.getDate() : i + 1}</b></button>`;
    }).join("")}</div>
    <section class="card" style="padding:36px;display:flex;flex-direction:column;gap:26px">
      <div><p class="eyebrow">${esc(label)}</p><h2 style="font-size:36px;margin-top:6px">${esc(day.title)}</h2>${day.place ? `<p class="muted" style="margin-top:6px">${esc(day.place)}</p>` : ""}</div>
      <div class="timeline">${day.items.length ? day.items.map((e) => `<div class="ev"><div class="tm">${esc(e.time_label)}</div><div class="ln"><i></i><s></s></div>
        <div class="tx"><b>${esc(e.title)}</b>${e.note ? `<span class="muted">${esc(e.note)}</span>` : ""}</div></div>`).join("") : `<p class="muted">A free day. Ask Mya for ideas anytime.</p>`}</div>
      <div class="noprint" style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <button class="btn line sm" type="button" data-act="day" data-v="${S.day - 1}" ${S.day === 0 ? "disabled" : ""}>Previous day</button>
        <button class="btn line sm" type="button" data-act="day" data-v="${S.day + 1}" ${S.day === days.length - 1 ? "disabled" : ""}>Next day</button></div>
    </section>`;
}

function secBookings() {
  const kinds = [["all", "All"], ["flight", "Flights"], ["hotel", "Hotels"], ["transfer", "Transfers"], ["experience", "Experiences"], ["other", "Other"]]
    .filter(([k]) => k === "all" || S.d.bookings.some((b) => b.kind === k));
  const list = S.d.bookings.filter((b) => S.filter === "all" || b.kind === S.filter);
  return head("Reservations", "Bookings &amp; confirmations") +
    `<div role="group" aria-label="Filter reservations" style="display:flex;flex-wrap:wrap;gap:8px">${kinds.map(([k, l]) => `<button class="pill" type="button" data-act="filter" data-v="${k}" aria-pressed="${S.filter === k}">${l}</button>`).join("")}</div>
    <div style="display:flex;flex-direction:column;gap:12px">${list.length ? list.map((b) => `<article class="card" style="padding:22px 26px;display:flex;flex-wrap:wrap;gap:20px;align-items:center">
      <div class="tag">${KIND_TAG[b.kind] || "RES"}</div>
      <div style="flex:1 1 260px"><p style="font-size:18px;font-weight:400">${esc(b.name)}</p><p class="muted small">${esc(b.details)}</p></div>
      <div style="flex:0 1 170px"><span class="lbl">Confirmation</span><p style="font-weight:500;letter-spacing:.08em">${esc(b.confirmation_no || "—")}</p></div>
      <div style="display:flex;align-items:center;gap:12px">${statusBadge(b.status)}
        ${b.document_id && doc(b.document_id) ? `<button class="btn line sm" type="button" data-act="doc" data-v="${b.document_id}" aria-label="View confirmation for ${esc(b.name)}">View</button>` : `<span class="muted small">Voucher coming soon</span>`}</div></article>`).join("") : `<div class="card"><p class="muted">No reservations here yet.</p></div>`}</div>`;
}

function secDocuments() {
  const mine = S.d.docs.filter((x) => x.category === "client");
  return head("Documents", "Your travel file", "", "Everything Mya adds is here to view and download. Your own documents go in the last section.") +
    `<div class="grid wide">${CATEGORIES.map(([k, title, sub]) => {
      const list = S.d.docs.filter((x) => x.category === k);
      return `<section class="card" style="padding:26px"><h2 style="font-size:26px">${title}</h2><p class="muted small" style="margin:4px 0 8px">${sub}</p>
        ${list.length ? list.map((x) => `<button class="rowbtn" type="button" data-act="doc" data-v="${x.id}">${ICON_DOC}<span style="flex:1;min-width:0"><span class="nm" style="display:block">${esc(x.title)}</span><span class="muted" style="font-size:12px">Added by Mya · ${esc(fmt(x.created_at.slice(0, 10), { month: "short", day: "numeric" }))}</span></span><span class="eyebrow" style="font-size:11px">Open</span></button>`).join("") : `<p class="empty">Nothing here yet.</p>`}</section>`;
    }).join("")}
    <section class="card" style="padding:26px;border-color:var(--gold)"><h2 style="font-size:26px">Your documents</h2><p class="muted small" style="margin:4px 0 8px">Passports, IDs, insurance cards. Only you and Mya can see these.</p>
      ${mine.length ? mine.map((x) => `<div style="display:flex;align-items:center;gap:10px;border-top:1px solid var(--line2)"><button class="rowbtn" style="border-top:0" type="button" data-act="doc" data-v="${x.id}">${ICON_DOC}<span style="flex:1;min-width:0"><span class="nm" style="display:block">${esc(x.title)}</span><span class="muted" style="font-size:12px">You uploaded · ${esc(fmt(x.created_at.slice(0, 10), { month: "short", day: "numeric" }))}</span></span></button>
        <button class="del" type="button" data-act="removeMine" data-v="${x.id}" aria-label="Remove ${esc(x.title)}">Remove</button></div>`).join("") : `<p class="empty">Nothing uploaded yet.</p>`}
      <label class="upload" style="margin-top:12px"><input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.heic,.webp" data-change="upload">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9M7 14l5-5 5 5M5 3h14"/></svg>${S.busy ? "Uploading…" : "Upload to your documents"}</label>
      <p class="muted" style="font-size:12px;margin-top:8px">PDF or photo, up to 20 MB each.</p></section></div>`;
}

function secCosts() {
  const ps = S.d.payments;
  const total = ps.reduce((a, p) => a + Number(p.amount), 0), rec = ps.filter((p) => p.received).reduce((a, p) => a + Number(p.amount), 0);
  const pct = total ? Math.round((rec / total) * 100) : 0;
  return head("Trip costs", "What's received, what's coming", "", "Payments are arranged directly with Mya. This page is your record of the schedule and your receipts.") +
    (ps.length ? `<section class="card" style="padding:34px;display:flex;flex-direction:column;gap:24px">
      <div class="grid"><div><span class="lbl">Trip total</span><p style="font-family:var(--display);font-size:40px;line-height:1.1">${money(total)}</p></div>
        <div><span class="lbl">Received</span><p style="font-family:var(--display);font-size:40px;line-height:1.1;color:var(--teal)">${money(rec)}</p></div>
        <div><span class="lbl">Remaining</span><p style="font-family:var(--display);font-size:40px;line-height:1.1">${money(total - rec)}</p></div></div>
      <div class="progress" role="img" aria-label="${pct}% received"><i style="width:${pct}%"></i></div></section>
    <section class="card" style="padding:30px 34px"><h2 style="font-size:28px;margin-bottom:12px">Schedule</h2>
      ${ps.map((p) => `<div class="list-row"><div style="flex:1 1 220px"><p style="font-size:17px;font-weight:400">${esc(p.name)}</p><p class="muted small">${p.received ? "Received" : "Due"} ${esc(fmtLong(p.due_date))}</p></div>
        <span style="flex:0 0 110px;font-size:17px;font-weight:400">${money(p.amount)}</span><span class="badge ${p.received ? "ok" : "wait"}">${p.received ? "Received" : "Upcoming"}</span>
        ${p.receipt_document_id && doc(p.receipt_document_id) ? `<button class="linkbtn" type="button" data-act="doc" data-v="${p.receipt_document_id}">View receipt</button>` : ""}</div>`).join("")}</section>`
      : `<div class="card"><p class="muted">Your payment schedule will appear here once your trip is booked.</p></div>`);
}

function secEssentials() {
  const c = S.d.checklist, done = c.filter((x) => x.done).length;
  const wa = `https://wa.me/${ADVISOR.phone}`, tel = `tel:+${ADVISOR.phone}`, sms = `sms:+${ADVISOR.phone}`;
  return head("Before you go", "Your pre-departure checklist") + `<div class="split">
    <section class="card a">${c.length ? `<p class="muted small" style="margin-bottom:10px">${done} of ${c.length} complete</p>` + c.map((x) => `<label class="list-row" style="cursor:pointer;align-items:flex-start;flex-wrap:nowrap">
        <input type="checkbox" data-change="check" data-v="${x.id}" ${x.done ? "checked" : ""} style="width:20px;height:20px;margin-top:3px;accent-color:#0C343A;flex:0 0 20px">
        <span><span style="display:block;font-size:16px;font-weight:400">${esc(x.title)}</span>${x.note ? `<span class="muted small">${esc(x.note)}</span>` : ""}</span></label>`).join("") : `<p class="muted">Mya will add your checklist here.</p>`}</section>
    <section class="contact b"><p class="eyebrow">Reaching Mya</p><h2 style="font-size:30px">My direct line</h2>
      <div class="sec"><span class="eyebrow" style="font-size:12px">Traveling abroad</span><span>Message or call me on WhatsApp so it works on any network.</span></div>
      <a class="btn gold" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>
      <div class="sec"><span class="eyebrow" style="font-size:12px">Within the US</span><span>A regular call or text is perfect.</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><a class="btn line" style="flex:1 1 120px" href="${tel}">Call</a><a class="btn line" style="flex:1 1 120px" href="${sms}">Text</a></div>
      <p style="letter-spacing:.06em">${esc(ADVISOR.phoneShown)}</p></section></div>`;
}

function updateRow(u) {
  const link = u.link_document_id ? "Open document" : u.link_section ? ({ itinerary: "See itinerary", bookings: "See reservations", documents: "See documents", costs: "See trip costs", essentials: "Open checklist" }[u.link_section] || "") : "";
  return `<button class="rowbtn" type="button" data-act="update" data-v="${u.id}" style="align-items:flex-start;padding:18px 0">
    <span class="dot ${S.d.read.has(u.id) ? "read" : ""}" aria-hidden="true"></span>
    <span style="flex:1;display:flex;flex-direction:column;gap:4px"><span class="eyebrow" style="font-size:11px">${u.kind === "reminder" ? "Reminder" : "Update"} · ${esc(fmt(u.created_at.slice(0, 10), { month: "short", day: "numeric" }))}${S.d.read.has(u.id) ? "" : '<span class="sr"> (unread)</span>'}</span>
      <span style="font-size:16px;line-height:1.55">${esc(u.body)}</span>${link ? `<span style="font-size:13px;font-weight:500;letter-spacing:.12em;color:var(--teal)">${link} →</span>` : ""}</span></button>`;
}

function secUpdates() {
  const list = S.d.updates.filter((u) => S.updFilter === "all" || u.kind === S.updFilter);
  const unread = S.d.updates.some((u) => !S.d.read.has(u.id));
  return head("From Mya", "Updates &amp; reminders", `<button class="btn line sm" type="button" data-act="readAll" ${unread ? "" : "disabled"}>Mark all as read</button>`) +
    `<div role="group" aria-label="Filter updates" style="display:flex;flex-wrap:wrap;gap:8px">${[["all", "All"], ["update", "Updates"], ["reminder", "Reminders"]].map(([k, l]) => `<button class="pill" type="button" data-act="updFilter" data-v="${k}" aria-pressed="${S.updFilter === k}">${l}</button>`).join("")}</div>
    <section class="card" style="padding:10px 30px 14px">${list.length ? list.map(updateRow).join("") : `<p class="empty" style="border:0">Nothing here yet.</p>`}</section>
    <p class="muted small">Have a question? Reach Mya directly on WhatsApp, by phone or by text. Details are under <button class="linkbtn" type="button" data-act="go" data-v="essentials">Before you go</button>.</p>`;
}

// ---------------- MRF itinerary keepsake (PDF via the browser's Save as PDF) ----------------
function itineraryDoc(coverPhoto) {
  const t = trip(), d = S.d;
  const nights = t.start_date && t.end_date ? Math.round((toDate(t.end_date) - toDate(t.start_date)) / 86400000) : null;
  const longDate = (iso) => (iso ? toDate(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "");
  const confirmed = d.bookings.filter((b) => b.status === "Confirmed").length;
  const places = [...new Set(d.days.map((x) => x.place).filter(Boolean).flatMap((p) => p.split(/\s*→\s*/)))].slice(0, 6);
  const cover = `<section class="pg"><div class="cover" style="${photoStyle(coverPhoto)}">
      <div class="brand"><b>MRF</b><span>TRAVELS</span></div>
      <div class="mid"><p class="kicker">Your private itinerary</p><h1>${esc(t.title)}</h1><div class="rule"></div>
        <p class="who">Prepared for ${esc(t.travelers || S.profile.full_name)}</p>
        <p class="dates">${esc(datesLine(t))}</p></div>
      <div class="foot"><div><b>${esc(ADVISOR.name)}</b>Luxury Travel Advisor · ${esc(ADVISOR.phoneShown)}</div><div>mrftravels.com</div></div>
    </div></section>`;
  const glance = `<section class="pg"><div class="sec-h"><p class="eyebrow">At a glance</p><h2>Your journey</h2></div>
      <div class="glance"><div><span class="eyebrow">Departing</span><b>${esc(fmt(t.start_date, { month: "short", day: "numeric" }))}</b><span class="dt">${t.start_date ? esc(`${fmt(t.start_date, { weekday: "long" })}, ${toDate(t.start_date).getFullYear()}`) : ""}</span></div>
        <div><span class="eyebrow">Length</span><b>${nights ?? "—"} nights</b><span class="dt">${d.days.length} days planned</span></div>
        <div><span class="eyebrow">Reservations</span><b>${confirmed} of ${d.bookings.length}</b><span class="dt">confirmed as of ${esc(fmt(new Date().toISOString().slice(0, 10)))}</span></div></div>
      ${places.length ? `<p style="margin-bottom:8mm;font-family:'Bodoni Moda',serif;font-style:italic;font-size:13pt;color:#0C343A">${places.map(esc).join("  ·  ")}</p>` : ""}
      ${d.bookings.length ? `<table><thead><tr><th style="width:52%">Reservation</th><th>Confirmation</th><th>Status</th></tr></thead><tbody>
        ${d.bookings.map((b) => `<tr><td><span class="nm">${esc(b.name)}</span><br><span class="dt">${esc(b.details)}</span></td><td class="conf">${esc(b.confirmation_no || "—")}</td><td><span class="st ${b.status === "Confirmed" ? "ok" : "wait"}">${b.status === "Confirmed" ? "Confirmed" : "In progress"}</span></td></tr>`).join("")}</tbody></table>` : ""}
    </section>`;
  const days = d.days.length ? `<section class="pg"><div class="sec-h"><p class="eyebrow">Day by day</p><h2>Your itinerary</h2></div>
      ${d.days.map((day, i) => { const x = day.day_date ? toDate(day.day_date) : null; return `<div class="day">
        <div class="date"><small>Day ${i + 1}</small><b>${x ? x.getDate() : i + 1}</b><span>${x ? `${x.toLocaleDateString("en-US", { weekday: "short" })} · ${x.toLocaleDateString("en-US", { month: "short" })}` : ""}</span></div>
        <div><h3>${esc(day.title)}</h3>${day.place ? `<p class="place">${esc(day.place)}</p>` : `<div style="height:3mm"></div>`}
          ${day.items.length ? day.items.map((e) => `<div class="ev"><span class="t">${esc(e.time_label)}</span><span><span class="w">${esc(e.title)}</span>${e.note ? `<span class="n">${esc(e.note)}</span>` : ""}</span></div>`).join("") : `<p class="dt">A free day to enjoy at your own pace.</p>`}</div></div>`; }).join("")}
    </section>` : "";
  const finale = `<section><div class="sec-h"><p class="eyebrow">Before you go</p><h2>Details &amp; contacts</h2></div>
      <div class="two"><div>${d.checklist.length ? d.checklist.map((c) => `<div class="chk"><i class="${c.done ? "on" : ""}"></i><span><span class="w" style="font-weight:400">${esc(c.title)}</span>${c.note ? `<span class="n">${esc(c.note)}</span>` : ""}</span></div>`).join("") : `<p class="dt">Your advisor will share your pre-departure checklist.</p>`}</div>
        <div><div class="box dark"><p class="eyebrow">Your advisor</p><h3>${esc(ADVISOR.name)}</h3>
          <p>Traveling abroad: message or call on WhatsApp.</p><p>Within the US: call or text.</p><p class="num">${esc(ADVISOR.phoneShown)}</p>
          <p style="margin-top:4mm">Your live portal, always up to date: mrftravels.com/portal</p></div></div></div>
      <div class="closing"><p>Wishing you a beautiful journey.</p><span>MRF Travels · Bespoke luxury travel</span></div></section>`;
  return `<div class="pdoc">${cover}${glance}${days}${finale}</div>`;
}

async function makePdf() {
  let root = document.getElementById("print-root");
  if (!root) { root = document.createElement("div"); root.id = "print-root"; document.body.appendChild(root); }
  const cover = nextCoverPhoto();
  root.innerHTML = itineraryDoc(cover);
  const t = trip(); const oldTitle = document.title;
  document.title = `MRF Travels Itinerary - ${t.title}`; // becomes the PDF's file name
  toast("Choose “Save as PDF” as the destination to download your itinerary.");
  try { await document.fonts?.ready; } catch {}
  const img = new Image(); img.src = cover.url;
  await Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
  setTimeout(() => { window.print(); setTimeout(() => { document.title = oldTitle; }, 500); }, 150);
}

// ---------------- actions ----------------
async function markRead(ids) {
  const fresh = ids.filter((id) => !S.d.read.has(id));
  if (!fresh.length) return;
  fresh.forEach((id) => S.d.read.add(id));
  if (S.preview) return; // only marked read on Mya's screen, not saved
  await sb.from("update_reads").upsert(fresh.map((update_id) => ({ update_id, user_id: S.profile.id })), { onConflict: "update_id,user_id", ignoreDuplicates: true });
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const v = el.dataset.v, act = el.dataset.act;
  if (act === "forgot") { S.showForgot = !S.showForgot; return render(); }
  if (act === "signout" && S.preview) return previewBlock("Sign out");
  if (act === "signout") { await sb.auth.signOut(); S.profile = null; S.trips = []; S.d = null; return show("signin"); }
  if (act === "go") { S.section = v; render(); $("#main")?.focus?.(); return window.scrollTo(0, 0); }
  if (act === "day") { S.section = "itinerary"; S.day = Math.max(0, Math.min(Number(v), S.d.days.length - 1)); return render(); }
  if (act === "filter") { S.filter = v; return render(); }
  if (act === "updFilter") { S.updFilter = v; return render(); }
  if (act === "pdf") return makePdf();
  if (act === "readAll") { await markRead(S.d.updates.map((u) => u.id)); return render(); }
  if (act === "doc") {
    const d = doc(v); if (!d) return;
    const mine = d.category === "client" && d.uploaded_by === S.profile.id;
    return openDocument(d, mine ? { onRemove: () => removeMine(d.id) } : {});
  }
  if (act === "removeMine") return removeMine(v);
  if (act === "update") {
    const u = S.d.updates.find((x) => x.id === v); if (!u) return;
    await markRead([u.id]);
    if (u.link_document_id && doc(u.link_document_id)) { render(); return openDocument(doc(u.link_document_id)); }
    if (u.link_section) S.section = u.link_section;
    return render();
  }
});

async function removeMine(id) {
  const d = doc(id); if (!d) return;
  if (S.preview) return previewBlock("Removing a file");
  if (!(await askConfirm(`"${d.title}" will be removed from your documents.`, { title: "Remove this file?", ok: "Remove", danger: true }))) return;
  const { error: se } = await sb.storage.from(BUCKET).remove([d.storage_path]);
  const { error } = await sb.from("documents").delete().eq("id", id);
  if (error || se) return toast("That file couldn't be removed. Please try again.");
  S.d.docs = S.d.docs.filter((x) => x.id !== id);
  render(); toast("Removed from your documents.");
}

document.addEventListener("change", async (e) => {
  const el = e.target.closest("[data-change]");
  if (!el) return;
  const kind = el.dataset.change;
  if (kind === "previewSwitch") { location.href = "?preview=" + encodeURIComponent(el.value); return; }
  if (kind === "trip") { S.tripId = el.value; try { localStorage.setItem("mrf-trip", el.value); } catch {} S.section = "overview"; S.day = 0; await loadTrip(); return render(); }
  if (kind === "check") {
    const item = S.d.checklist.find((x) => x.id === el.dataset.v); const val = el.checked;
    if (S.preview) { el.checked = !val; return previewBlock("Ticking the checklist"); }
    const { error } = await sb.from("checklist_items").update({ done: val }).eq("id", item.id);
    if (error) { el.checked = !val; return toast("That didn't save. Please try again."); }
    item.done = val; return render();
  }
  if (kind === "upload") {
    const files = Array.from(el.files || []); if (!files.length) return;
    if (S.preview) { el.value = ""; return previewBlock("Uploading to Your documents"); }
    const tooBig = files.find((f) => f.size > 20 * 1024 * 1024);
    if (tooBig) { el.value = ""; return toast(`${tooBig.name} is over 20 MB.`); }
    S.busy = true; render();
    let ok = 0;
    for (const f of files) {
      try {
        const path = await uploadFile(S.tripId, "client", f);
        const { data, error } = await sb.from("documents").insert({ trip_id: S.tripId, category: "client", title: f.name.replace(/\.[^.]+$/, ""), storage_path: path, uploaded_by: S.profile.id }).select().single();
        if (error) throw error;
        S.d.docs.push(data); ok++;
      } catch (err) { console.error(err); }
    }
    S.busy = false; render();
    toast(ok === files.length ? (ok === 1 ? "Uploaded to Your documents. Mya can see it now." : `${ok} files uploaded to Your documents.`) : "Some files didn't upload. Please try again.");
  }
});

document.addEventListener("submit", async (e) => {
  const f = e.target; e.preventDefault();
  if (f.id === "f-signin") {
    const u = f.u.value.trim(), p = f.p.value; S.lastUser = u;
    if (!u || !p) return show("signin", "Enter your username and password.");
    setRemember(f.remember.checked);
    S.busy = true; render();
    const { error } = await sb.auth.signInWithPassword({ email: loginEmail(u), password: p });
    S.busy = false;
    if (error) return show("signin", "That username and password don't match. Check them and try again.");
    S.error = ""; S.section = "overview"; await afterSignIn();
  }
  if (f.id === "f-setup") {
    const nu = f.nu.value.trim().toLowerCase(), np = f.np.value, np2 = f.np2.value;
    if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(nu)) return show("setup", "Usernames use 3–30 letters or numbers (dots, dashes and underscores are fine).");
    if (np.length < 10 || !/[0-9\W_]/.test(np)) return show("setup", "Your password needs at least 10 characters, including a number or symbol.");
    if (np !== np2) return show("setup", "The two passwords don't match.");
    S.busy = true; render();
    try {
      await callAccounts({ action: "set_login", username: nu, password: np });
      await sb.auth.signOut();
      const { error } = await sb.auth.signInWithPassword({ email: loginEmail(nu), password: np });
      if (error) throw new Error("Saved. Please sign in with your new username and password.");
      S.busy = false; S.error = "";
      await afterSignIn();
      toast("All set. Next time, sign in with your new username and password.");
    } catch (err) {
      S.busy = false;
      const { data } = await sb.auth.getSession();
      show(data.session ? "setup" : "signin", err.message);
    }
  }
});

sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT" && S.screen === "portal") show("signin"); });
boot();
