// MRF Travels — Advisor Studio (Mya only; requires password + authenticator code)
import { sb, $, esc, askConfirm, fmt, fmtLong, daysUntil, money, toast, openDocument, uploadFile, callAccounts,
  CATEGORIES, KIND_TAG, BUCKET, toDate } from "./lib.js?v=202611171805";

const app = $("#app");
const S = { screen: "loading", error: "", busy: false, view: "dashboard", tripId: null, tab: "itinerary", D: null, mfa: null, creds: null, invited: null };
const BRAND = `<a class="logo" href="/"><b>MRF</b><span>Advisor Studio</span></a>`;
const TODAY = () => new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

// ---------------- sign in + authenticator ----------------
async function boot() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return show("signin");
  await gate();
}

async function gate() {
  const { data: role } = await sb.rpc("my_role");
  if (role !== "advisor") { await sb.auth.signOut(); return show("signin", "This sign-in is for the advisor only. Clients sign in at mrftravels.com/portal."); }
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal2") { await loadAll(); return show("studio"); }
  const { data: f } = await sb.auth.mfa.listFactors();
  const verified = (f?.totp || []).find((x) => x.status === "verified");
  if (verified) { S.mfa = { factorId: verified.id }; return show("verify"); }
  // first time: set up the authenticator app
  for (const x of f?.all || []) if (x.status !== "verified") await sb.auth.mfa.unenroll({ factorId: x.id });
  const { data: en, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "MRF Advisor Studio" });
  if (error) return show("signin", "Couldn't start authenticator setup: " + error.message);
  S.mfa = { factorId: en.id, qr: en.totp.qr_code, secret: en.totp.secret };
  show("enroll");
}

function show(screen, error = "") { S.screen = screen; S.error = error; render(); }

// ---------------- data ----------------
async function loadAll() {
  const all = (t, order = "sort") => sb.from(t).select("*").order(order);
  const [trips, members, profiles, days, items, bookings, docs, payments, updates, reads, checklist, tasks] = await Promise.all([
    sb.from("trips").select("*").order("start_date"), sb.from("trip_members").select("*"), sb.from("profiles").select("*"),
    all("itinerary_days"), all("itinerary_items"), all("bookings"), all("documents", "created_at"), all("payments"),
    sb.from("updates").select("*").order("created_at", { ascending: false }), sb.from("update_reads").select("*"),
    all("checklist_items"), sb.from("advisor_tasks").select("*").order("created_at"),
  ]);
  const err = [trips, members, profiles, days, items, bookings, docs, payments, updates, checklist, tasks].find((r) => r.error);
  if (err) { console.error(err.error); toast("Some data didn't load. Refresh the page."); }
  S.D = {
    trips: trips.data || [], members: members.data || [], profiles: profiles.data || [], days: days.data || [], items: items.data || [],
    bookings: bookings.data || [], docs: docs.data || [], payments: payments.data || [], updates: updates.data || [],
    reads: reads.data || [], checklist: checklist.data || [], tasks: tasks.data || [],
  };
}
const by = (arr, tripId) => arr.filter((x) => x.trip_id === tripId);
const T = (id) => S.D.trips.find((t) => t.id === id);
const clientsOf = (tripId) => S.D.members.filter((m) => m.trip_id === tripId).map((m) => S.D.profiles.find((p) => p.id === m.user_id)).filter(Boolean);
const tripLabel = (t) => t.travelers || clientsOf(t.id).map((p) => p.full_name).join(" & ") || "No client yet";

async function run(promise, okMsg) {
  const { error } = await promise;
  if (error) { console.error(error); toast("That didn't save: " + (error.message || "please try again.")); return false; }
  await loadAll(); render(); if (okMsg) toast(okMsg); return true;
}

// ---------------- what's missing ----------------
function gapsFor(t) {
  const g = [], add = (kind, text, tab, badge = "wait") => g.push({ kind, text, tab, badge, tripId: t.id });
  if (t.status === "Complete") return g;
  const people = clientsOf(t.id);
  if (!people.length) add("Login", "No client login yet", "people", "muted");
  people.filter((p) => p.must_set_login).forEach((p) => add("Login", `${p.full_name} hasn't signed in yet`, "people", "muted"));
  by(S.D.bookings, t.id).forEach((b) => {
    if (b.status === "Pending") add("Confirm", `Confirm ${b.name}`, "bookings");
    else if (!b.document_id) add("Voucher", `Attach voucher for ${b.name}`, "bookings");
  });
  by(S.D.payments, t.id).filter((p) => !p.received && p.due_date).forEach((p) => {
    const d = daysUntil(p.due_date);
    if (d < 0) add("Overdue", `${p.name} ${money(p.amount)} was due ${fmt(p.due_date)}`, "costs", "warn");
    else if (d <= 30) add("Payment", `${p.name} ${money(p.amount)} due ${fmt(p.due_date)}`, "costs");
  });
  if (people.length && !by(S.D.docs, t.id).some((d) => d.category === "client")) add("Docs", "Waiting on passport copies", "documents", "muted");
  if (!by(S.D.items, t.id).length) add("Itinerary", "Itinerary has no plans yet", "itinerary", "muted");
  return g;
}
function readiness(t) {
  const parts = [], b = by(S.D.bookings, t.id), p = by(S.D.payments, t.id), c = by(S.D.checklist, t.id);
  if (b.length) parts.push(b.filter((x) => x.status === "Confirmed" && x.document_id).length / b.length);
  if (p.length) parts.push(p.filter((x) => x.received).length / p.length);
  if (c.length) parts.push(c.filter((x) => x.done).length / c.length);
  parts.push(by(S.D.docs, t.id).some((d) => d.category === "client") ? 1 : 0);
  parts.push(by(S.D.items, t.id).length ? 1 : 0);
  return Math.round((parts.reduce((a, x) => a + x, 0) / parts.length) * 100);
}
const activeTrips = () => S.D.trips.filter((t) => t.status !== "Complete");
const allClients = () => S.D.profiles.filter((p) => p.role === "client").sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
const tripsOf = (userId) => S.D.members.filter((m) => m.user_id === userId).map((m) => T(m.trip_id)).filter(Boolean);

// ---------------- render ----------------
function render() {
  app.innerHTML = ({ signin: vSignIn, enroll: vEnroll, verify: vVerify, studio: vStudio }[S.screen] || (() => `<div class="loading">Loading…</div>`))();
}

const alertBox = () => (S.error ? `<p class="alert" role="alert">${esc(S.error)}</p>` : "");
function vSignIn() {
  return `<div class="centered"><form class="panel-card" id="f-signin" novalidate>${BRAND}
    <h1 style="font-size:38px">Welcome back, Mya</h1>
    <div class="field"><label for="e">Email</label><input class="input" id="e" name="e" type="email" autocomplete="username" required></div>
    <div class="field"><label for="p">Password</label><input class="input" id="p" name="p" type="password" autocomplete="current-password" required></div>
    ${alertBox()}<button class="btn" type="submit" ${S.busy ? "disabled" : ""}>${S.busy ? "Signing in…" : "Continue"}</button>
    <p class="muted small">Clients sign in at <a href="../">mrftravels.com/portal</a>.</p></form></div>`;
}
function vEnroll() {
  return `<div class="centered"><form class="panel-card" id="f-mfa" novalidate>${BRAND}
    <p class="eyebrow">One-time setup</p><h1 style="font-size:34px">Protect your studio</h1>
    <p class="muted">Your studio can see every client's documents, so it needs a second step. Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password or Apple Passwords), add a new account and scan this code.</p>
    <div style="background:#fff;padding:16px;align-self:center"><img src="${esc(S.mfa.qr)}" alt="Authenticator QR code" width="180" height="180"></div>
    <p class="muted small">Can't scan? Enter this key instead: <code style="color:var(--gold);word-break:break-all">${esc(S.mfa.secret)}</code></p>
    <div class="field"><label for="code">6-digit code from the app</label><input class="input" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="letter-spacing:.4em" required></div>
    ${alertBox()}<button class="btn" type="submit" ${S.busy ? "disabled" : ""}>Turn on and enter</button>
    <button class="linkbtn" type="button" data-act="signout">Cancel</button></form></div>`;
}
function vVerify() {
  return `<div class="centered"><form class="panel-card" id="f-mfa" novalidate>${BRAND}
    <h1 style="font-size:34px">Your 6-digit code</h1><p class="muted">Open your authenticator app and enter the code for MRF Advisor Studio.</p>
    <div class="field"><label for="code">Code</label><input class="input" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="letter-spacing:.4em" autofocus required></div>
    ${alertBox()}<button class="btn" type="submit" ${S.busy ? "disabled" : ""}>Enter studio</button>
    <button class="linkbtn" type="button" data-act="signout">Use a different account</button></form></div>`;
}

function vStudio() {
  const gaps = activeTrips().flatMap((t) => gapsFor(t).map((g) => ({ ...g, trip: t })));
  const openTasks = S.D.tasks.filter((k) => !k.done).length;
  const navBtn = (k, l, n) => `<button class="nav" type="button" data-act="view" data-v="${k}" ${S.view === k || (k === "trips" && S.view === "trip") ? 'aria-current="page"' : ""}>${l}${n ? `<span class="count">${n}</span>` : ""}</button>`;
  const body = { dashboard: () => vDashboard(gaps, openTasks), trips: vTrips, trip: vTrip, invite: vInvite, todo: vTodo }[S.view]();
  return `<header class="top"><div class="in">${BRAND}<div class="r">
      <button class="btn line sm" type="button" data-act="viewAs">View as client</button><span>Mya Ferrera</span>
      <button class="btn line sm" type="button" data-act="signout">Sign out</button></div></div></header>
    <div class="shell"><nav class="side" aria-label="Studio">${navBtn("dashboard", "Dashboard", gaps.length)}${navBtn("trips", "Clients &amp; trips", activeTrips().length)}${navBtn("invite", "Invite a client")}${navBtn("todo", "My to-do", openTasks)}</nav>
    <main class="main">${body}</main></div>`;
}

const h = (eyebrow, title, right = "", sub = "") => `<div class="head"><div class="t"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ""}</div>${right}</div>`;
const dates = (t) => (t.start_date ? `${fmt(t.start_date)}${t.end_date ? " – " + fmt(t.end_date) : ""}` : "Dates to be set");

function vDashboard(gaps, openTasks) {
  const upcoming = activeTrips().filter((t) => t.end_date ? daysUntil(t.end_date) >= 0 : true).slice(0, 5);
  const soon = activeTrips().filter((t) => { const d = daysUntil(t.start_date); return d !== null && d >= 0 && d <= 60; }).length;
  const stat = (k, n, v) => `<button class="card stat" type="button" data-act="view" data-v="${v}"><span class="k">${k}</span><span class="n">${n}</span></button>`;
  return h(TODAY().toUpperCase(), "Here's where everything stands") +
    `<div class="grid">${stat("Active trips", activeTrips().length, "trips")}${stat("Departing in 60 days", soon, "trips")}${stat("Things missing", gaps.length, "dashboard")}${stat("Open to-dos", openTasks, "todo")}</div>
    <div class="split"><section class="card a"><h2 style="font-size:28px">What's still missing</h2><p class="muted small" style="margin:4px 0 12px">Worked out automatically from every trip. Click one to jump to it.</p>
      ${gaps.length ? gaps.map((g) => `<button class="rowbtn" type="button" data-act="open" data-v="${g.tripId}" data-tab="${g.tab}"><span class="badge ${g.badge}">${g.kind}</span>
        <span style="flex:1"><span class="nm" style="display:block;font-weight:400">${esc(g.text)}</span><span class="muted small">${esc(tripLabel(g.trip))} · ${esc(g.trip.title)}</span></span><span class="eyebrow" style="font-size:11px">Open →</span></button>`).join("") : `<p class="empty">Nothing missing. Every trip is in order.</p>`}</section>
    <section class="card b"><h2 style="font-size:28px;margin-bottom:12px">Next departures</h2>
      ${upcoming.length ? upcoming.map((t) => { const d = daysUntil(t.start_date); return `<button class="rowbtn" type="button" data-act="open" data-v="${t.id}">
        <span class="datebox"><b style="color:var(--gold)">${d === null ? "—" : Math.max(0, d)}</b><small>DAYS</small></span>
        <span><span class="nm" style="display:block;font-weight:400">${esc(tripLabel(t))}</span><span class="muted small">${esc(t.title)}</span></span></button>`; }).join("") : `<p class="empty">No trips yet. <button class="linkbtn" type="button" data-act="view" data-v="invite">Invite your first client</button></p>`}</section></div>`;
}

function vTrips() {
  const list = [...S.D.trips].sort((a, b) => (a.status === "Complete") - (b.status === "Complete") || (a.start_date || "9").localeCompare(b.start_date || "9"));
  return h("Clients &amp; trips", "Every journey in motion", `<button class="btn" type="button" data-act="view" data-v="invite">Invite a client</button>`) +
    (list.length ? `<div class="grid wide">${list.map((t) => { const g = gapsFor(t).length, r = readiness(t), d = daysUntil(t.start_date);
      return `<button class="card stat" type="button" data-act="open" data-v="${t.id}" style="gap:10px">
        <span style="display:flex;justify-content:space-between;gap:10px"><span class="badge ${t.status === "Planning" ? "wait" : t.status === "Complete" ? "muted" : "ok"}">${esc(t.status)}</span>
          ${clientsOf(t.id).some((p) => p.must_set_login) ? `<span class="badge wait">Login invited</span>` : clientsOf(t.id).length ? `<span class="badge muted">Login active</span>` : ""}</span>
        <span style="font-family:var(--display);font-size:26px;line-height:1.15">${esc(tripLabel(t))}</span><span style="color:var(--muted)">${esc(t.title)}</span>
        <span class="small muted">${esc(dates(t))}${d !== null && d >= 0 ? ` · ${d} days out` : ""}</span>
        <span style="display:flex;justify-content:space-between;font-size:12px;letter-spacing:.1em;color:var(--muted)"><span>READINESS</span><span>${r}%</span></span>
        <span class="progress" style="height:4px"><i style="width:${r}%;background:var(--gold)"></i></span>
        <span class="small" style="color:var(--gold)">${g ? `${g} thing${g === 1 ? "" : "s"} missing` : "Nothing missing"}</span></button>`; }).join("")}</div>`
      : `<div class="card"><p class="muted">No trips yet.</p></div>`);
}

const TABS = [["itinerary", "Itinerary"], ["bookings", "Reservations"], ["documents", "Documents"], ["costs", "Trip costs"], ["updates", "Updates"],
  ["checklist", "Client checklist"], ["tasks", "My to-dos"], ["people", "Travelers &amp; logins"], ["details", "Trip details"]];

function vTrip() {
  const t = T(S.tripId);
  if (!t) { S.view = "trips"; return vTrips(); }
  const d = daysUntil(t.start_date);
  const tabs = `<div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button class="tab" role="tab" type="button" data-act="tab" data-v="${k}" aria-selected="${S.tab === k}">${l}</button>`).join("")}</div>`;
  const creds = S.creds ? `<div class="card" style="border-color:var(--gold);display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between">
      <div>${S.creds.returning ? `<span class="lbl">${esc(S.creds.name)} uses their existing login</span><p style="font-size:16px">Let them know their new trip is in the portal.</p>` : `<span class="lbl">New temporary login for ${esc(S.creds.name)}</span><p style="font-size:16px">Username <b style="font-weight:500;color:var(--gold)">${esc(S.creds.username)}</b> · Password <b style="font-weight:500;color:var(--gold)">${esc(S.creds.password)}</b></p>`}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${draftButtons(S.creds, "copyCreds")}<button class="btn line sm" type="button" data-act="hideCreds">Done</button></div>
      ${S.creds.email ? "" : `<p class="muted small" style="flex-basis:100%">No email on file for ${esc(S.creds.name)}, so the draft opens without a recipient. Add it in the To line.</p>`}</div>` : "";
  const body = { itinerary: tItinerary, bookings: tBookings, documents: tDocuments, costs: tCosts, updates: tUpdates, checklist: tChecklist, tasks: tTasks, people: tPeople, details: tDetails }[S.tab](t);
  return `<button class="btn line sm" type="button" data-act="view" data-v="trips" style="align-self:flex-start">← All trips</button>
    <div class="head"><div class="t"><p class="eyebrow">${esc(dates(t).toUpperCase())}${d !== null && d >= 0 ? ` · ${d} DAYS OUT` : ""}</p><h1>${esc(t.title)}</h1><p class="muted">${esc(tripLabel(t))}</p></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn line sm" type="button" data-act="viewAs" data-v="${t.id}">View as client</button><label class="sr" for="status">Trip status</label>
      <select id="status" class="input" style="width:auto;min-width:150px" data-change="status">${["Planning", "Booked", "Traveling", "Complete"].map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select></div></div>
    ${creds}${tabs}${body}`;
}

const panel = (a, b) => `<div class="split"><section class="card a">${a}</section><section class="card b" style="display:flex;flex-direction:column;gap:16px">${b}</section></div>`;
const fld = (id, label, attrs = "", type = "text") => `<div class="field"><label for="${id}">${label}</label><input class="input" id="${id}" name="${id}" type="${type}" ${attrs}></div>`;
const sel = (id, label, opts, val = "") => `<div class="field"><label for="${id}">${label}</label><select class="input" id="${id}" name="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`;

function tItinerary(t) {
  const days = by(S.D.days, t.id).sort((a, b) => (a.day_date || "").localeCompare(b.day_date || "") || a.sort - b.sort);
  const list = days.length ? days.map((d, i) => `<div style="padding:14px 0;border-top:1px solid var(--line2)">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline"><h3 style="font-size:20px">Day ${i + 1}${d.day_date ? " · " + esc(fmt(d.day_date, { weekday: "short", month: "short", day: "numeric" })) : ""} · ${esc(d.title)}</h3>
        <button class="del" type="button" data-act="del" data-t="itinerary_days" data-v="${d.id}" aria-label="Remove day ${i + 1}">Remove day</button></div>
      ${d.place ? `<p class="muted small">${esc(d.place)}</p>` : ""}
      ${by(S.D.items, t.id).filter((x) => x.day_id === d.id).sort((a, b) => a.sort - b.sort).map((e) => `<div style="display:flex;gap:14px;align-items:center;padding:4px 0">
        <span style="flex:0 0 84px;color:var(--gold)">${esc(e.time_label)}</span><span style="flex:1">${esc(e.title)}${e.note ? `<span class="muted small"> · ${esc(e.note)}</span>` : ""}</span>
        <button class="del" type="button" data-act="del" data-t="itinerary_items" data-v="${e.id}" aria-label="Remove ${esc(e.title)}">Remove</button></div>`).join("")}</div>`).join("")
    : `<p class="muted">No days yet. Add the first one on the right.</p>`;
  return panel(list, `<form data-form="day"><h3 style="font-size:22px">Add a day</h3>
      ${fld("title", "Day title", 'required placeholder="Arrival at Lake Como"')}<div class="row2">${fld("day_date", "Date", "", "date")}${fld("place", "Place")}</div>
      <button class="btn line sm" type="submit" style="margin-top:14px">Add day</button></form>
    ${days.length ? `<div style="height:1px;background:var(--line)"></div><form data-form="item"><h3 style="font-size:22px">Add to a day</h3>
      ${sel("day_id", "Day", days.map((d, i) => [d.id, `Day ${i + 1} · ${d.title}`]))}
      <div class="row2">${fld("time_label", "Time", 'placeholder="10:00 AM"')}${fld("title", "What's happening", "required")}</div>${fld("note", "Note for the client (optional)")}
      <button class="btn sm" type="submit" style="margin-top:14px">Add to itinerary</button></form>` : ""}`);
}

function tBookings(t) {
  const list = by(S.D.bookings, t.id);
  return panel(list.length ? list.map((b) => { const doc = S.D.docs.find((x) => x.id === b.document_id); return `<div class="list-row">
      <span class="tag" style="flex-basis:44px;height:44px">${KIND_TAG[b.kind]}</span>
      <span style="flex:1 1 220px"><span style="display:block;font-weight:400">${esc(b.name)}</span><span class="muted small">${esc(b.details)}${b.confirmation_no ? " · Conf. " + esc(b.confirmation_no) : ""}</span></span>
      <span class="badge ${b.status === "Confirmed" ? "ok" : "wait"}">${b.status}</span>
      ${doc ? `<button class="linkbtn" type="button" data-act="doc" data-v="${doc.id}">Voucher</button>` : `<label class="upload" style="min-height:36px;padding:6px 12px;font-size:11px">Attach voucher<input type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.webp" data-change="voucher" data-v="${b.id}"></label>`}
      <button class="btn line sm" type="button" data-act="toggleBooking" data-v="${b.id}">${b.status === "Confirmed" ? "Mark pending" : "Mark confirmed"}</button>
      <button class="del" type="button" data-act="del" data-t="bookings" data-v="${b.id}" aria-label="Remove ${esc(b.name)}">Remove</button></div>`; }).join("") : `<p class="muted">No reservations yet.</p>`,
    `<form data-form="booking"><h3 style="font-size:22px">Add a reservation</h3>
      <div class="row2">${sel("kind", "Type", [["hotel", "Hotel"], ["flight", "Flight"], ["transfer", "Transfer / train"], ["experience", "Experience"], ["other", "Other"]])}${sel("status", "Status", [["Pending", "Pending"], ["Confirmed", "Confirmed"]])}</div>
      ${fld("name", "Name", 'required placeholder="Le Sirenuse, Positano"')}${fld("details", "Dates &amp; details", 'placeholder="May 17 – 21 · Sea-view room"')}${fld("confirmation_no", "Confirmation #")}
      <button class="btn sm" type="submit" style="margin-top:14px">Add reservation</button></form>
      <p class="muted small">A voucher you attach shows under the reservation and in the client's Documents, so both open the same file.</p>`);
}

function tDocuments(t) {
  const docs = by(S.D.docs, t.id);
  const row = (x, canDel) => `<div class="list-row" style="padding:10px 0"><button class="linkbtn" type="button" data-act="doc" data-v="${x.id}" style="flex:1;text-align:left;color:var(--ink)">${esc(x.title)}</button>
      ${canDel ? `<button class="del" type="button" data-act="delDoc" data-v="${x.id}" aria-label="Remove ${esc(x.title)}">Remove</button>` : ""}</div>`;
  return `<div class="grid wide">${CATEGORIES.map(([k, title]) => `<section class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px"><h3 style="font-size:22px">${title}</h3>
      <label class="upload" style="min-height:40px;padding:8px 14px;font-size:11px">Upload<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.heic,.webp" data-change="docs" data-v="${k}"></label></div>
      ${docs.filter((x) => x.category === k).map((x) => row(x, true)).join("") || `<p class="empty">Nothing yet.</p>`}</section>`).join("")}
    <section class="card"><h3 style="font-size:22px">Client uploads</h3><p class="muted small" style="margin:4px 0 8px">What the client added under "Your documents". View only.</p>
      ${docs.filter((x) => x.category === "client").map((x) => row(x, false)).join("") || `<p class="empty" style="color:#E59A8C">Nothing yet. Passport copies are still missing.</p>`}</section></div>`;
}

const seesItem = (vis, uid) => !vis || !vis.length || vis.includes(uid);
const whoLabel = (vis, tripId) => !vis || !vis.length ? "Everyone on the trip" : vis.map((id) => S.D.profiles.find((p) => p.id === id)?.full_name || "Removed traveler").join(" & ");
function tCosts(t) {
  const people = clientsOf(t.id);
  if (S.costFor && !people.some((p) => p.id === S.costFor)) S.costFor = "";
  const ps = by(S.D.payments, t.id).filter((p) => !S.costFor || seesItem(p.visible_to, S.costFor));
  const forWho = people.length > 1 ? `<div class="field" style="max-width:360px;margin-bottom:14px"><label for="costFor">Show</label><select id="costFor" class="input" data-change="costFor">
      <option value="">All costs on this trip</option>${people.map((p) => `<option value="${p.id}" ${S.costFor === p.id ? "selected" : ""}>What ${esc(p.full_name)} sees</option>`).join("")}</select></div>` : "";
  const total = ps.reduce((a, p) => a + Number(p.amount), 0), rec = ps.filter((p) => p.received).reduce((a, p) => a + Number(p.amount), 0);
  return panel(`${forWho}<div style="display:flex;flex-wrap:wrap;gap:28px;margin-bottom:12px"><div><span class="lbl">Total</span><p style="font-family:var(--display);font-size:32px">${money(total)}</p></div>
      <div><span class="lbl">Received</span><p style="font-family:var(--display);font-size:32px;color:#BFE0DC">${money(rec)}</p></div><div><span class="lbl">Outstanding</span><p style="font-family:var(--display);font-size:32px;color:var(--gold)">${money(total - rec)}</p></div></div>
    ${ps.length ? ps.map((p) => { const d = daysUntil(p.due_date), receipt = S.D.docs.find((x) => x.id === p.receipt_document_id); return `<div class="list-row">
      <span style="flex:1 1 200px"><span style="display:block;font-weight:400">${esc(p.name)}</span><span class="muted small">${p.received ? "Was due" : "Due"} ${esc(fmt(p.due_date))}</span>
        ${people.length > 1 || (p.visible_to && p.visible_to.length) ? `<span class="muted small" style="display:block">Seen by: ${esc(whoLabel(p.visible_to, t.id))} · <button class="linkbtn" type="button" data-act="payWho" data-v="${p.id}">Change</button></span>` : ""}</span>
      <span style="flex:0 0 90px">${money(p.amount)}</span><span class="badge ${p.received ? "ok" : d !== null && d < 0 ? "warn" : "wait"}">${p.received ? "Received" : d !== null && d < 0 ? "Overdue" : "Upcoming"}</span>
      <button class="btn line sm" type="button" data-act="togglePay" data-v="${p.id}">${p.received ? "Undo" : "Mark received"}</button>
      ${receipt ? `<button class="linkbtn" type="button" data-act="doc" data-v="${receipt.id}">Receipt</button>` : p.received ? `<label class="upload" style="min-height:36px;padding:6px 12px;font-size:11px">Attach receipt<input type="file" accept=".pdf,.jpg,.jpeg,.png" data-change="receipt" data-v="${p.id}"></label>` : ""}
      <button class="del" type="button" data-act="del" data-t="payments" data-v="${p.id}" aria-label="Remove ${esc(p.name)}">Remove</button></div>`; }).join("") : `<p class="muted">No payment schedule yet.</p>`}`,
    `<form data-form="payment"><h3 style="font-size:22px">Add to the schedule</h3>${fld("name", "Name", 'required placeholder="Final balance"')}
      <div class="row2">${fld("amount", "Amount ($)", 'required min="0" step="0.01"', "number")}${fld("due_date", "Due date", "required", "date")}</div>
      ${people.length > 1 ? `<fieldset style="border:0;padding:0;margin:14px 0 0"><legend class="lbl">Who sees this cost?</legend><p class="muted small" style="margin:2px 0 6px">Tick the travelers it belongs to (both partners for a couple). Leave all unticked for a shared cost everyone sees.</p>
        ${people.map((p) => `<label class="check" style="display:flex;margin:4px 0"><input type="checkbox" name="who" value="${p.id}" ${S.costFor === p.id ? "checked" : ""}> ${esc(p.full_name)}</label>`).join("")}</fieldset>` : ""}
      <button class="btn sm" type="submit" style="margin-top:14px">Add</button></form>
    <p class="muted small">Clients only see this as a record. When a payment arrives, mark it received and attach the receipt. It shows up in their Documents too, only for the people who see that cost.</p>`);
}

function tUpdates(t) {
  const ups = by(S.D.updates, t.id), docs = by(S.D.docs, t.id).filter((d) => d.category !== "client");
  const people = clientsOf(t.id).map((p) => p.id);
  return panel(ups.length ? ups.map((u) => { const seen = S.D.reads.some((r) => r.update_id === u.id && people.includes(r.user_id)); return `<div class="list-row">
      <span class="badge ${u.kind === "reminder" ? "wait" : "ok"}">${u.kind === "reminder" ? "Reminder" : "Update"}</span>
      <span style="flex:1 1 240px"><span style="display:block">${esc(u.body)}</span><span class="muted small">Posted ${esc(fmt(u.created_at.slice(0, 10)))} · ${seen ? "Read by client" : "Not read yet"}</span></span>
      <button class="del" type="button" data-act="del" data-t="updates" data-v="${u.id}" aria-label="Remove update">Remove</button></div>`; }).join("") : `<p class="muted">Nothing posted yet.</p>`,
    `<form data-form="update"><h3 style="font-size:22px">Send to the client</h3>${sel("kind", "Type", [["update", "Update"], ["reminder", "Reminder"]])}
      <div class="field" style="margin-top:12px"><label for="body">Message</label><textarea class="input" id="body" name="body" rows="4" required></textarea></div>
      <div class="row2" style="margin-top:12px">${sel("link_section", "Link to a page (optional)", [["", "None"], ["itinerary", "Itinerary"], ["bookings", "Reservations"], ["documents", "Documents"], ["costs", "Trip costs"], ["essentials", "Before you go"]])}
      ${sel("link_document_id", "Or a document (optional)", [["", "None"], ...docs.map((d) => [d.id, d.title])])}</div>
      <button class="btn sm" type="submit" style="margin-top:14px">Post to client portal</button></form>
    <p class="muted small">One way: the client reads it in "Updates &amp; reminders" and can't reply in the portal.</p>`);
}

function tChecklist(t) {
  const c = by(S.D.checklist, t.id);
  return panel(c.length ? `<p class="muted small">The client ticks these off. ${c.filter((x) => x.done).length} of ${c.length} done.</p>` + c.map((x) => `<div class="list-row">
      <span class="badge ${x.done ? "ok" : "muted"}">${x.done ? "Done" : "Open"}</span><span style="flex:1">${esc(x.title)}${x.note ? `<span class="muted small"> · ${esc(x.note)}</span>` : ""}</span>
      <button class="del" type="button" data-act="del" data-t="checklist_items" data-v="${x.id}" aria-label="Remove ${esc(x.title)}">Remove</button></div>`).join("") : `<p class="muted">No checklist items yet.</p>`,
    `<form data-form="check"><h3 style="font-size:22px">Add a checklist item</h3>${fld("title", "Item", 'required placeholder="Upload passport copies"')}${fld("note", "Helpful note (optional)")}
      <button class="btn sm" type="submit" style="margin-top:14px">Add</button></form>
    <button class="btn line sm" type="button" data-act="starterChecklist">Add my standard checklist</button>`);
}

function tTasks(t) {
  const ks = S.D.tasks.filter((k) => k.trip_id === t.id);
  return panel(ks.length ? ks.map(taskRow).join("") : `<p class="muted">No to-dos for this trip.</p>`,
    `<form data-form="task"><h3 style="font-size:22px">Add a to-do</h3><input type="hidden" name="trip_id" value="${t.id}">${fld("body", "Only you see these", 'required placeholder="Ask hotel about anniversary setup"')}
      <button class="btn sm" type="submit" style="margin-top:14px">Add to-do</button></form>`);
}
const taskRow = (k) => `<label class="list-row" style="cursor:pointer;flex-wrap:nowrap"><input type="checkbox" data-change="task" data-v="${k.id}" ${k.done ? "checked" : ""} style="width:18px;height:18px;accent-color:#D3B47E;flex:0 0 18px">
  <span style="flex:1"><span class="${k.done ? "done-text" : ""}">${esc(k.body)}</span>${S.view === "todo" && k.trip_id ? `<span class="muted small" style="display:block">${esc(T(k.trip_id) ? tripLabel(T(k.trip_id)) + " · " + T(k.trip_id).title : "")}</span>` : ""}</span>
  <button class="del" type="button" data-act="del" data-t="advisor_tasks" data-v="${k.id}" aria-label="Remove to-do">Remove</button></label>`;

function tPeople(t) {
  const people = clientsOf(t.id);
  const others = allClients().filter((p) => !people.some((x) => x.id === p.id));
  return panel(people.length ? people.map((p) => {
      const also = tripsOf(p.id).filter((x) => x.id !== t.id);
      return `<div class="list-row"><span style="flex:1 1 220px"><span style="display:block;font-weight:400">${esc(p.full_name)}</span>
      <span class="muted small">Username: ${esc(p.username || "—")}${p.contact_email ? " · " + esc(p.contact_email) : ""}</span>
      ${also.length ? `<span class="muted small" style="display:block">Also sees: ${also.map((x) => esc(x.title)).join(", ")}</span>` : ""}</span>
      <span class="badge ${p.must_set_login ? "wait" : "ok"}">${p.must_set_login ? "Hasn't signed in yet" : "Login active"}</span>
      <button class="btn line sm" type="button" data-act="resetLogin" data-v="${p.id}">Reset login</button>
      ${also.length ? `<button class="del" type="button" data-act="unlinkClient" data-v="${p.id}">Remove from this trip</button>` : `<button class="del" type="button" data-act="removeClient" data-v="${p.id}">Remove login</button>`}</div>`;
    }).join("") : `<p class="muted">No one has a login for this trip yet.</p>`,
    `${others.length ? `<form data-form="linkClient" style="margin-bottom:22px"><h3 style="font-size:22px">Add a returning client</h3><p class="muted small">They keep their own login and see this trip next to their other trips.</p>
      ${sel("user_id", "Client", others.map((p) => [p.id, `${p.full_name}${p.username ? " (" + p.username + ")" : ""}`]))}
      <button class="btn sm" type="submit" style="margin-top:14px">Add to this trip</button></form>` : ""}
    <form data-form="addTraveler"><h3 style="font-size:22px">Give someone a login</h3><p class="muted small">For a travel companion, or a client who needs a fresh account.</p>
      <div class="row2">${fld("first_name", "First name", "required")}${fld("last_name", "Last name", "required")}</div>${fld("contact_email", "Their email (for the welcome email)", "", "email")}
      <button class="btn sm" type="submit" style="margin-top:14px" ${S.busy ? "disabled" : ""}>Create temporary login</button></form>`);
}

function tDetails(t) {
  return `<section class="card" style="max-width:720px"><form data-form="details" style="display:flex;flex-direction:column;gap:16px">
    ${fld("title", "Trip name", `required value="${esc(t.title)}"`)}${fld("travelers", "Travelers (shown on the client's banner)", `value="${esc(t.travelers)}"`)}
    <div class="row2">${fld("start_date", "Departs", `value="${esc(t.start_date || "")}"`, "date")}${fld("end_date", "Returns", `value="${esc(t.end_date || "")}"`, "date")}</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap"><button class="btn sm" type="submit">Save trip details</button>
    <button class="del" type="button" data-act="deleteTrip">Delete this trip</button></div></form></section>`;
}

function vInvite() {
  const inv = S.invited;
  return h("Invite a client", "After the first consultation", "", "This creates the client's trip and a temporary login. Send them the login. On their first sign-in they choose their own username and password, and the temporary one stops working.") +
    `<div class="split"><form class="card a" data-form="invite" style="display:flex;flex-direction:column;gap:18px">
      <div class="field"><label for="who">Who is this trip for?</label><select id="who" class="input" data-change="inviteWho">
        <option value="">A new client (creates their login)</option>
        ${allClients().length ? `<optgroup label="Returning client (keeps their login)">${allClients().map((p) => `<option value="${p.id}" ${S.inviteWho === p.id ? "selected" : ""}>${esc(p.full_name)} · ${tripsOf(p.id).length} trip${tripsOf(p.id).length === 1 ? "" : "s"}</option>`).join("")}</optgroup>` : ""}</select></div>
      ${S.inviteWho ? `${fld("travelers", "Travelers (e.g. Elena &amp; Marco Reyes)", `value="${esc(S.D.profiles.find((p) => p.id === S.inviteWho)?.full_name || "")}"`)}` : `<div class="row2">${fld("first_name", "First name", "required")}${fld("last_name", "Last name", "required")}</div>
      <div class="row2">${fld("contact_email", "Client's email (for the welcome email)", "", "email")}${fld("travelers", "Travelers (e.g. Elena &amp; Marco Reyes)")}</div>`}
      ${fld("title", "Trip name", 'required placeholder="Lake Como &amp; the Amalfi Coast"')}
      <div class="row2">${fld("start_date", "Departs", "", "date")}${fld("end_date", "Returns", "", "date")}</div>
      <label class="check"><input type="checkbox" name="starter" checked> Add my standard checklist and to-dos</label>
      ${S.error ? `<p class="alert" role="alert">${esc(S.error)}</p>` : ""}
      <button class="btn" type="submit" style="align-self:flex-start" ${S.busy ? "disabled" : ""}>${S.busy ? "Creating…" : S.inviteWho ? "Create trip in their portal" : "Create trip &amp; temporary login"}</button></form>
    <section class="card b" style="display:flex;flex-direction:column;gap:14px"><h3 style="font-size:24px">Their login</h3>
      ${inv && inv.returning ? `<p>${esc(inv.name)} already has a login, so nothing new to send them, just a heads-up that their new trip is ready.</p>
        <p style="padding:14px;background:var(--bg);font-size:14px;white-space:pre-line">${esc(inviteMessage(inv))}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">${draftButtons(inv, "copyInvite")}<button class="btn line sm" type="button" data-act="open" data-v="${inv.tripId}">Open their trip</button></div>`
      : inv ? `<div><span class="lbl">Temporary username</span><p style="font-size:18px;color:var(--gold)">${esc(inv.username)}</p></div>
        <div><span class="lbl">Temporary password</span><p style="font-size:18px;color:var(--gold);letter-spacing:.06em">${esc(inv.password)}</p></div>
        <p style="padding:14px;background:var(--bg);font-size:14px;white-space:pre-line">${esc(inviteMessage(inv))}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">${draftButtons(inv, "copyInvite")}<button class="btn line sm" type="button" data-act="open" data-v="${inv.tripId}">Open their trip</button></div>
        <p class="muted small">"Open in my email app" opens a ready-to-send email in your computer\'s Mail app. Close it and choose Save to keep it in Drafts. This password is shown only now; if it's lost, use Reset login on their trip.</p>`
      : `<p class="muted">Fill in the form and the temporary login appears here, with a welcome message ready to paste into WhatsApp, a text or an email.</p>`}</section></div>`;
}
const inviteSubject = (c) => c.returning ? `Your next trip is in your MRF Travels portal` : `Your MRF Travels client portal is ready`;
const returningMessage = (c, forEmail = false) => `Hi ${c.first},

I'm so excited to be planning ${c.tripTitle ? c.tripTitle : "your next trip"} with you! It's now in your MRF Travels client portal, right alongside your other trips, and I'll keep it up to date as we go.

Sign in at https://mrftravels.com/portal with the same username and password you already use. If you have more than one trip, you can switch between them at the top of the page, or under "Your trips".

Forgot your login? Just text or WhatsApp me at (786) 287-2156 and I'll reset it for you.

Warmly,${forEmail ? "\n" : "\nMya"}`;
const inviteMessage = (c, forEmail = false) => c.returning ? returningMessage(c, forEmail) : `Hi ${c.first},

I'm so excited to be planning ${c.tripTitle ? c.tripTitle : "your trip"} with you! Everything for your journey (your itinerary, confirmations, documents and updates) now lives in your private MRF Travels client portal, and I'll keep it up to date as we go.

Here's how to get in:

1. Go to mrftravels.com and choose "Client login" from the menu, or go straight to https://mrftravels.com/portal
2. Sign in with your temporary login:
   Username: ${c.username}
   Temporary password: ${c.password}
3. You'll be asked to choose your own username and password. Pick something only you know. The temporary one stops working as soon as you save.

Once you're in, take a look at "Before you go" for your checklist, and upload a copy of your passport under Documents, then Your documents.

If you have any trouble signing in, just text or WhatsApp me at (786) 287-2156.

Warmly,${forEmail ? "\n" : "\nMya"}`; // in Gmail, Mya's saved signature is added below
// Opens a new message in the computer's own email app (Apple Mail, Outlook…), ready to send or save as a draft.
const mailtoUrl = (c) => `mailto:${(c.email || "").replace(/[^\w.+@-]/g, "")}?subject=${encodeURIComponent(inviteSubject(c))}&body=${encodeURIComponent(inviteMessage(c, true).replace(/\n/g, "\r\n"))}`;
const draftButtons = (c, copyAct) => `<a class="btn sm" href="${esc(mailtoUrl(c))}">Open in my email app</a>
  <button class="btn line sm" type="button" data-act="${copyAct}">Copy message</button>`;

function vTodo() {
  const ks = [...S.D.tasks].sort((a, b) => a.done - b.done);
  return h("My to-do", "Across every trip") + panel(ks.length ? ks.map(taskRow).join("") : `<p class="muted">Nothing on your list.</p>`,
    `<form data-form="task"><h3 style="font-size:22px">Add a to-do</h3>${sel("trip_id", "Trip", [["", "General (no trip)"], ...activeTrips().map((t) => [t.id, `${tripLabel(t)} · ${t.title}`])])}
      ${fld("body", "To-do", "required")}<button class="btn sm" type="submit" style="margin-top:14px">Add to-do</button></form>`);
}

// ---------------- starter content ----------------
const STARTER_CHECK = [
  ["Check passport validity", "Valid at least 6 months past your return date, with blank pages."],
  ["Upload passport copies", "Add them under Documents → Your documents."],
  ["Review your travel insurance", "Your policy will be in Documents."],
  ["Tell your bank you're traveling", "Bring a card with no foreign transaction fees."],
  ["Share dietary preferences with Mya", "She passes them to restaurants and experiences."],
  ["Save Mya in WhatsApp", "The easiest way to reach her while abroad."],
];
const STARTER_TASKS = ["Send trip proposal", "Book flights", "Book hotels", "Arrange transfers", "Upload all vouchers", "Final itinerary review"];
const addStarterChecklist = (tripId) => sb.from("checklist_items").insert(STARTER_CHECK.map(([title, note], i) => ({ trip_id: tripId, title, note, sort: i })));

// ---------------- events ----------------
async function copy(text, ok) {
  try { await navigator.clipboard.writeText(text); toast(ok); } catch { toast("Copy was blocked. Select the text and copy it."); }
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const { act, v } = el.dataset;
  if (act === "signout") { await sb.auth.signOut(); S.D = null; return show("signin"); }
  if (act === "viewAs") return pickClient(v);
  if (act === "view") { S.view = v; S.error = ""; S.creds = null; render(); return scrollTo(0, 0); }
  if (act === "open") { S.view = "trip"; S.tripId = v; S.tab = el.dataset.tab || "itinerary"; S.creds = null; render(); return scrollTo(0, 0); }
  if (act === "tab") { S.tab = v; return render(); }
  if (act === "doc") { const d = S.D.docs.find((x) => x.id === v); if (d) openDocument(d); return; }
  if (act === "del") { if (!(await askConfirm("This can't be undone.", { title: "Remove this?", ok: "Remove", danger: true }))) return; return run(sb.from(el.dataset.t).delete().eq("id", v), "Removed."); }
  if (act === "delDoc") {
    const d = S.D.docs.find((x) => x.id === v); if (!d || !(await askConfirm(`"${d.title}" will be deleted and the client won't see it anymore.`, { title: "Remove this document?", ok: "Remove", danger: true }))) return;
    await sb.storage.from(BUCKET).remove([d.storage_path]); return run(sb.from("documents").delete().eq("id", v), "Document removed.");
  }
  if (act === "toggleBooking") { const b = S.D.bookings.find((x) => x.id === v); return run(sb.from("bookings").update({ status: b.status === "Confirmed" ? "Pending" : "Confirmed" }).eq("id", v)); }
  if (act === "togglePay") { const p = S.D.payments.find((x) => x.id === v); return run(sb.from("payments").update({ received: !p.received }).eq("id", v)); }
  if (act === "starterChecklist") return run(addStarterChecklist(S.tripId), "Standard checklist added.");
  if (act === "hideCreds") { S.creds = null; return render(); }
  if (act === "copyCreds") return copy(inviteMessage(S.creds), "Message copied.");
  if (act === "copyInvite") return copy(inviteMessage(S.invited), "Welcome message copied.");
  if (act === "resetLogin") {
    const p = S.D.profiles.find((x) => x.id === v);
    if (!(await askConfirm(`${p.full_name} gets a new temporary username and password. Their current password stops working right away.`, { title: "Reset this login?", ok: "Reset login" }))) return;
    try { const r = await callAccounts({ action: "reset", user_id: v }); S.creds = { ...r, name: p.full_name, first: p.full_name.split(" ")[0], email: p.contact_email || "", tripTitle: T(S.tripId)?.title }; await loadAll(); render(); toast("New temporary login ready."); }
    catch (err) { toast(err.message); }
    return;
  }
  if (act === "removeClient") {
    const p = S.D.profiles.find((x) => x.id === v);
    if (!(await askConfirm(`${p.full_name} won't be able to sign in anymore. Their trips and documents stay.`, { title: "Remove this login?", ok: "Remove login", danger: true }))) return;
    try { await callAccounts({ action: "remove", user_id: v }); await loadAll(); render(); toast("Login removed."); } catch (err) { toast(err.message); }
    return;
  }
  if (act === "payWho") {
    const p = S.D.payments.find((x) => x.id === v); if (!p) return;
    const who = await chooseWho(p.trip_id, p.visible_to || [], p.name);
    if (who === null) return;
    return run(sb.from("payments").update({ visible_to: who.length ? who : null }).eq("id", v), who.length ? `Now only ${whoLabel(who)} see${who.length === 1 ? "s" : ""} "${p.name}" and its receipt.` : `Everyone on the trip sees "${p.name}" now.`);
  }
  if (act === "unlinkClient") {
    const p = S.D.profiles.find((x) => x.id === v), t = T(S.tripId);
    if (!(await askConfirm(`${p.full_name} won't see "${t.title}" anymore. They keep their login and their other trips.`, { title: "Remove from this trip?", ok: "Remove from trip", danger: true }))) return;
    return run(sb.from("trip_members").delete().eq("trip_id", S.tripId).eq("user_id", v), "Removed from this trip.");
  }
  if (act === "deleteTrip") {
    const t = T(S.tripId);
    if (!(await askConfirm(`This permanently deletes "${t.title}" with its itinerary, reservations, documents and payments. Client logins stay.`, { title: "Delete this trip?", ok: "Delete trip", danger: true, typeToConfirm: "DELETE" }))) return;
    const paths = by(S.D.docs, t.id).map((d) => d.storage_path);
    if (paths.length) await sb.storage.from(BUCKET).remove(paths);
    S.view = "trips"; return run(sb.from("trips").delete().eq("id", t.id), "Trip deleted.");
  }
});

document.addEventListener("change", async (e) => {
  const el = e.target.closest("[data-change]"); if (!el) return;
  const kind = el.dataset.change, v = el.dataset.v;
  if (kind === "costFor") { S.costFor = el.value; return render(); }
  if (kind === "inviteWho") { S.inviteWho = el.value; S.invited = null; S.error = ""; return render(); }
  if (kind === "status") return run(sb.from("trips").update({ status: el.value }).eq("id", S.tripId), "Status updated.");
  if (kind === "task") return run(sb.from("advisor_tasks").update({ done: el.checked }).eq("id", v));
  const files = Array.from(el.files || []); if (!files.length) return;
  if (files.some((f) => f.size > 20 * 1024 * 1024)) { el.value = ""; return toast("Files must be under 20 MB."); }
  toast("Uploading…");
  try {
    if (kind === "docs") {
      for (const f of files) {
        const path = await uploadFile(S.tripId, v, f);
        const { error } = await sb.from("documents").insert({ trip_id: S.tripId, category: v, title: f.name.replace(/\.[^.]+$/, ""), storage_path: path });
        if (error) throw error;
      }
      await loadAll(); render(); return toast(`${files.length} file${files.length === 1 ? "" : "s"} added. The client can see ${files.length === 1 ? "it" : "them"} now.`);
    }
    if (kind === "voucher" || kind === "receipt") {
      const f = files[0];
      const target = kind === "voucher" ? S.D.bookings.find((x) => x.id === v) : S.D.payments.find((x) => x.id === v);
      const cat = kind === "receipt" ? "receipts" : target.kind === "flight" ? "tickets" : "confirmations";
      const path = await uploadFile(S.tripId, cat, f);
      const title = kind === "receipt" ? `Receipt · ${target.name}` : target.name;
      const { data: d, error } = await sb.from("documents").insert({ trip_id: S.tripId, category: cat, title, storage_path: path }).select().single();
      if (error) throw error;
      const upd = kind === "voucher" ? sb.from("bookings").update({ document_id: d.id }).eq("id", v) : sb.from("payments").update({ receipt_document_id: d.id }).eq("id", v);
      return run(upd, kind === "voucher" ? "Voucher attached. It shows under the reservation and in Documents." : "Receipt attached.");
    }
  } catch (err) { console.error(err); toast("Upload failed: " + (err.message || "please try again.")); }
});

document.addEventListener("submit", async (e) => {
  const f = e.target; e.preventDefault();
  const val = (n) => (f.elements[n]?.value ?? "").trim();
  if (f.id === "f-signin") {
    S.busy = true; render();
    const { error } = await sb.auth.signInWithPassword({ email: val("e") || f.e.value, password: f.p.value });
    S.busy = false;
    if (error) return show("signin", "That email and password don't match.");
    return gate();
  }
  if (f.id === "f-mfa") {
    const code = val("code").replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) return show(S.screen, "Enter the 6 digits from your authenticator app.");
    S.busy = true; render();
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: S.mfa.factorId, code });
    S.busy = false;
    if (error) return show(S.screen, "That code didn't work. Codes change every 30 seconds, so try the newest one.");
    await loadAll(); return show("studio");
  }
  const form = f.dataset.form; if (!form) return;
  const t = S.tripId;
  if (form === "day") return run(sb.from("itinerary_days").insert({ trip_id: t, title: val("title"), day_date: val("day_date") || null, place: val("place"), sort: by(S.D.days, t).length }), "Day added.");
  if (form === "item") return run(sb.from("itinerary_items").insert({ trip_id: t, day_id: val("day_id"), time_label: val("time_label"), title: val("title"), note: val("note"), sort: S.D.items.filter((x) => x.day_id === val("day_id")).length }), "Added. The client sees it right away.");
  if (form === "booking") return run(sb.from("bookings").insert({ trip_id: t, kind: val("kind"), status: val("status"), name: val("name"), details: val("details"), confirmation_no: val("confirmation_no"), sort: by(S.D.bookings, t).length }), "Reservation added.");
  if (form === "payment") {
    const who = Array.from(f.querySelectorAll('input[name="who"]:checked')).map((x) => x.value);
    return run(sb.from("payments").insert({ trip_id: t, name: val("name"), amount: Number(val("amount")), due_date: val("due_date"), sort: by(S.D.payments, t).length, visible_to: who.length ? who : null }),
      who.length ? `Added. Only ${whoLabel(who, t)} will see it.` : "Added to the schedule.");
  }
  if (form === "update") return run(sb.from("updates").insert({ trip_id: t, kind: val("kind"), body: val("body"), link_section: val("link_section") || null, link_document_id: val("link_document_id") || null }), "Posted. It's in their Updates & reminders now.");
  if (form === "check") return run(sb.from("checklist_items").insert({ trip_id: t, title: val("title"), note: val("note"), sort: by(S.D.checklist, t).length }), "Added to their checklist.");
  if (form === "task") return run(sb.from("advisor_tasks").insert({ trip_id: val("trip_id") || (S.view === "trip" ? t : null), body: val("body") }), "To-do added.");
  if (form === "details") return run(sb.from("trips").update({ title: val("title"), travelers: val("travelers"), start_date: val("start_date") || null, end_date: val("end_date") || null }).eq("id", t), "Trip details saved.");
  if (form === "linkClient") {
    const uid = val("user_id"), p = S.D.profiles.find((x) => x.id === uid), tr = T(t);
    if (!p) return;
    const ok = await run(sb.from("trip_members").insert({ trip_id: t, user_id: uid }));
    if (ok) { S.creds = { returning: true, name: p.full_name, first: (p.full_name || "").split(" ")[0], email: p.contact_email || "", tripTitle: tr?.title }; render(); toast(`${p.full_name} can see this trip now.`); }
    return;
  }
  if (form === "addTraveler") {
    S.busy = true; render();
    try {
      const r = await callAccounts({ action: "invite", trip_id: t, first_name: val("first_name"), last_name: val("last_name"), contact_email: val("contact_email") });
      S.creds = { ...r, name: `${val("first_name")} ${val("last_name")}`, first: val("first_name"), email: val("contact_email"), tripTitle: T(t)?.title };
      S.busy = false; await loadAll(); render(); toast("Temporary login ready.");
    } catch (err) { S.busy = false; render(); toast(err.message); }
    return;
  }
  if (form === "invite" && S.inviteWho) {
    const p = S.D.profiles.find((x) => x.id === S.inviteWho), title = val("title");
    if (!p || !title) return show("studio", "Choose the client and add a trip name.");
    S.busy = true; S.error = ""; render();
    const { data: trip, error } = await sb.from("trips").insert({ title, travelers: val("travelers") || p.full_name, start_date: val("start_date") || null, end_date: val("end_date") || null }).select().single();
    if (error) { S.busy = false; return show("studio", "Couldn't create the trip: " + error.message); }
    const { error: me } = await sb.from("trip_members").insert({ trip_id: trip.id, user_id: p.id });
    if (me) { S.busy = false; await loadAll(); return show("studio", `The trip was created, but ${p.full_name} couldn't be added to it: ${me.message} Add them from the trip's "Travelers & logins" tab.`); }
    if (f.starter.checked) {
      await addStarterChecklist(trip.id);
      await sb.from("advisor_tasks").insert(STARTER_TASKS.map((body) => ({ trip_id: trip.id, body })));
    }
    await sb.from("updates").insert({ trip_id: trip.id, kind: "update", body: "Your next adventure is here! I'll add your plans as we build this trip together." });
    S.invited = { returning: true, name: p.full_name, first: (p.full_name || "").split(" ")[0], tripId: trip.id, email: p.contact_email || "", tripTitle: title };
    S.inviteWho = ""; S.busy = false; await loadAll(); render(); toast(`Trip created. ${p.full_name} can see it now.`);
    return;
  }
  if (form === "invite") {
    const first = val("first_name"), last = val("last_name"), title = val("title");
    if (!first || !last || !title) return show("studio", "Add the client's first and last name and a trip name.");
    S.busy = true; S.error = ""; render();
    const { data: trip, error } = await sb.from("trips").insert({ title, travelers: val("travelers") || `${first} ${last}`, start_date: val("start_date") || null, end_date: val("end_date") || null }).select().single();
    if (error) { S.busy = false; return show("studio", "Couldn't create the trip: " + error.message); }
    try {
      const r = await callAccounts({ action: "invite", trip_id: trip.id, first_name: first, last_name: last, contact_email: val("contact_email") });
      if (f.starter.checked) {
        await addStarterChecklist(trip.id);
        await sb.from("advisor_tasks").insert(STARTER_TASKS.map((body) => ({ trip_id: trip.id, body })));
      }
      await sb.from("updates").insert({ trip_id: trip.id, kind: "update", body: "Welcome to your portal! I'll add your plans here as we build your trip together." });
      S.invited = { ...r, first, tripId: trip.id, email: val("contact_email"), tripTitle: title };
      S.busy = false; await loadAll(); render(); toast("Trip created and login ready.");
    } catch (err) {
      S.busy = false; await loadAll(); show("studio", `The trip was created, but the login wasn't: ${err.message} You can add it from the trip's "Travelers & logins" tab.`);
    }
  }
});

// pick which travelers see a cost → Promise<string[] | null>
function chooseWho(tripId, current, name) {
  return new Promise((resolve) => {
    const people = clientsOf(tripId);
    const wrap = document.createElement("div"); wrap.className = "overlay";
    wrap.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="cw-t" style="max-width:480px">
      <div style="padding:28px 28px 8px;display:flex;flex-direction:column;gap:12px"><h2 id="cw-t" style="font-size:28px">Who sees "${esc(name)}"?</h2>
      <p class="muted small">Tick the travelers this cost belongs to. Its receipt follows. Leave all unticked for a shared cost everyone on the trip sees.</p>
      ${people.map((p) => `<label class="check" style="display:flex"><input type="checkbox" value="${p.id}" ${current.includes(p.id) ? "checked" : ""}> ${esc(p.full_name)}</label>`).join("") || `<p class="muted">No travelers have a login on this trip yet.</p>`}</div>
      <div class="df"><button class="btn line sm" type="button" data-x>Cancel</button><button class="btn sm" type="button" data-ok>Save</button></div></div>`;
    const done = (val) => { wrap.remove(); resolve(val); };
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.closest("[data-x]")) return done(null);
      if (e.target.closest("[data-ok]")) done(Array.from(wrap.querySelectorAll("input:checked")).map((x) => x.value));
    });
    document.body.appendChild(wrap); wrap.querySelector("input,[data-ok]")?.focus();
  });
}

// ---------------- view the portal as a client (read-only preview) ----------------
function pickClient(onlyTrip) {
  const trips = [...S.D.trips].filter((t) => !onlyTrip || t.id === onlyTrip).sort((a, b) => (a.start_date || "9").localeCompare(b.start_date || "9"));
  const personRow = (t, p) => `<a class="rowbtn" href="../?preview=${t.id}&as=${p.id}" style="text-decoration:none;color:inherit"><span style="flex:1;min-width:0"><span class="nm" style="display:block">${esc(p.full_name)}</span><span class="muted" style="font-size:13px">${esc(p.username || "")}${p.must_set_login ? " · hasn't signed in yet" : ""}</span></span><span class="eyebrow" style="font-size:11px">View</span></a>`;
  const wrap = document.createElement("div");
  wrap.className = "overlay";
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  wrap.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="va-t" style="max-width:560px">
    <div class="dh"><h2 id="va-t" style="font-size:28px">Who do you want to view as?</h2><button class="btn line sm" type="button" data-x>Close</button></div>
    <div style="padding:8px 24px 20px;overflow:auto;min-height:0"><p class="muted small" style="margin:8px 0 12px">Opens their portal exactly as they see it. Nothing you click there changes their trip.</p>
    ${trips.length ? trips.map((t) => { const ps = clientsOf(t.id).sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
      return `<p class="eyebrow" style="margin:18px 0 2px">${esc(t.title)} · ${esc(dates(t))}</p>${ps.length ? ps.map((p) => personRow(t, p)).join("") : `<a class="rowbtn" href="../?preview=${t.id}" style="text-decoration:none;color:inherit"><span style="flex:1" class="muted">No client login yet · preview the trip</span><span class="eyebrow" style="font-size:11px">View</span></a>`}`; }).join("") : `<p class="muted">No trips yet.</p>`}</div></div>`;
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-x]")) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(wrap);
  wrap.querySelector("a,[data-x]")?.focus();
}

// ---------------- chat file import (lets any Claude chat add a PDF it was given) ----------------
// A chat encrypts the file (AES-256-GCM) and pushes only the ciphertext to the repo's "inbox" branch.
// The key travels in the chat's call below, never on GitHub. This runs with Mya's own signed-in session.
const INBOX = "https://raw.githubusercontent.com/Myaf2005/MRFTravels/inbox/";
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function importFile({ file, key, iv, name, tripId, category, title, bookingIds = [], paymentId = null, contentType = "application/pdf" }) {
  if (S.screen !== "studio" || !S.D) throw new Error("Studio isn't signed in (password + code) in this tab.");
  const trip = T(tripId); if (!trip) throw new Error("No trip with id " + tripId);
  const bookings = bookingIds.map((id) => S.D.bookings.find((b) => b.id === id && b.trip_id === tripId));
  if (bookings.some((b) => !b)) throw new Error("A booking id doesn't belong to this trip.");
  const payment = paymentId ? S.D.payments.find((p) => p.id === paymentId && p.trip_id === tripId) : null;
  if (paymentId && !payment) throw new Error("That payment id doesn't belong to this trip.");
  let res;
  for (let i = 0; i < 12; i++) { res = await fetch(INBOX + file + "?t=" + Date.now(), { cache: "no-store" }); if (res.ok) break; await new Promise((r) => setTimeout(r, 2500)); }
  if (!res.ok) throw new Error("Couldn't find " + file + " in the inbox (" + res.status + ").");
  const k = await crypto.subtle.importKey("raw", b64(key), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(iv) }, k, await res.arrayBuffer()); // fails if tampered
  const blob = new File([plain], name, { type: contentType });
  if (blob.size > 20 * 1024 * 1024) throw new Error("Files must be under 20 MB.");
  const cat = category || (payment ? "receipts" : bookings[0]?.kind === "flight" ? "tickets" : "confirmations");
  const path = await uploadFile(tripId, cat, blob);
  const docTitle = title || (payment ? `Receipt · ${payment.name}` : bookings[0]?.name) || name.replace(/\.[^.]+$/, "");
  const { data: d, error } = await sb.from("documents").insert({ trip_id: tripId, category: cat, title: docTitle, storage_path: path }).select().single();
  if (error) throw error;
  // link the chosen reservations, plus any other leg of this trip with the same confirmation number
  const confs = new Set(bookings.map((b) => (b.confirmation_no || "").trim()).filter(Boolean));
  const linkIds = new Set(bookingIds);
  S.D.bookings.filter((b) => b.trip_id === tripId && !b.document_id && confs.has((b.confirmation_no || "").trim())).forEach((b) => linkIds.add(b.id));
  if (linkIds.size) { const { error: e2 } = await sb.from("bookings").update({ document_id: d.id }).in("id", [...linkIds]); if (e2) throw e2; }
  if (payment) { const { error: e3 } = await sb.from("payments").update({ receipt_document_id: d.id }).eq("id", payment.id); if (e3) throw e3; }
  await loadAll(); render(); toast(`"${docTitle}" added${linkIds.size ? ` and linked to ${linkIds.size} reservation${linkIds.size === 1 ? "" : "s"}` : ""}.`);
  return { documentId: d.id, category: cat, title: docTitle, linkedBookings: [...linkIds], linkedPayment: payment?.id || null };
}
function snapshot(tripId) {
  if (!S.D) return { signedIn: false };
  const trips = S.D.trips.map((t) => ({ id: t.id, title: t.title, travelers: tripLabel(t), start: t.start_date, end: t.end_date }));
  if (!tripId) return { signedIn: S.screen === "studio", trips };
  return {
    signedIn: S.screen === "studio", trip: trips.find((t) => t.id === tripId),
    bookings: by(S.D.bookings, tripId).map((b) => ({ id: b.id, kind: b.kind, name: b.name, confirmation_no: b.confirmation_no, details: b.details, status: b.status, hasDocument: !!b.document_id })),
    payments: by(S.D.payments, tripId).map((p) => ({ id: p.id, name: p.name, hasReceipt: !!p.receipt_document_id })),
    documents: by(S.D.docs, tripId).map((d) => ({ id: d.id, category: d.category, title: d.title })),
  };
}
window.mrf = { snapshot, importFile };

boot();
