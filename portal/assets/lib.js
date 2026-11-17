// MRF Travels portal — shared setup and helpers
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

export const SUPABASE_URL = "https://rydpyqrvwvejhclcbhuf.supabase.co";
// Publishable key: safe in the browser. Every table is protected by row-level security.
export const SUPABASE_KEY = "sb_publishable_nFOf7Wu9hriXIv8-xO3hdw_HOKuzDGb";
export const CLIENT_DOMAIN = "clients.mrftravels.com";
export const ADVISOR = { name: "Mya Ferrera", phone: "17862872156", phoneShown: "(786) 287-2156" };
export const BUCKET = "trip-files";

// "Keep me signed in" → remembered on this device; otherwise only until the browser closes.
const REMEMBER_KEY = "mrf-remember";
const remember = () => { try { return localStorage.getItem(REMEMBER_KEY) !== "0"; } catch { return true; } };
const storage = {
  getItem: (k) => { try { return (remember() ? localStorage : sessionStorage).getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { (remember() ? localStorage : sessionStorage).setItem(k, v); } catch {} },
  removeItem: (k) => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
};
export function setRemember(on) { try { localStorage.setItem(REMEMBER_KEY, on ? "1" : "0"); } catch {} }
export function getRemember() { return remember(); }

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// usernames sign in as <username>@clients.mrftravels.com; an email address signs in as itself
export const loginEmail = (u) => (u.includes("@") ? u.trim() : `${u.trim().toLowerCase()}@${CLIENT_DOMAIN}`);

export async function callAccounts(payload) {
  const { data, error } = await sb.functions.invoke("portal-accounts", { body: payload });
  if (error) {
    let msg = "Something went wrong. Please try again.";
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return data;
}

// ---------- tiny helpers ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const toDate = (iso) => { if (!iso) return null; const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
export const fmt = (iso, opts = { month: "short", day: "numeric", year: "numeric" }) => (iso ? toDate(iso).toLocaleDateString("en-US", opts) : "");
export const fmtLong = (iso) => fmt(iso, { month: "long", day: "numeric", year: "numeric" });
export const daysUntil = (iso) => { if (!iso) return null; const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((toDate(iso) - t) / 86400000); };
export const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const initials = (name) => (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
export const safeName = (n) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "-").slice(-80);
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

let toastTimer;
export function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

// ---------- document viewer (same viewer everywhere a file opens) ----------
export async function openDocument(doc, { onRemove } = {}) {
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(doc.storage_path, 600);
  if (error || !data?.signedUrl) { toast("That file couldn't be opened. Please try again."); return; }
  const url = data.signedUrl;
  const isImg = /\.(jpe?g|png|webp|heic)$/i.test(doc.storage_path);
  const wrap = document.createElement("div");
  wrap.className = "overlay";
  wrap.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(doc.title)}">
    <div class="dh"><div><div class="eyebrow">${esc(categoryLabel(doc.category))}</div><div style="font-size:17px;font-weight:400">${esc(doc.title)}</div></div>
      <button class="icon-btn" type="button" data-close aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="db">${isImg ? `<img src="${esc(url)}" alt="${esc(doc.title)}">` : `<iframe src="${esc(url)}" title="${esc(doc.title)}"></iframe>`}</div>
    <div class="df">${onRemove ? `<button class="btn line sm" type="button" data-remove>Remove</button>` : ""}
      <button class="btn line sm" type="button" data-close>Close</button>
      <a class="btn sm" href="${esc(url)}&download=${encodeURIComponent(doc.title)}" download>Download</a></div></div>`;
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  wrap.addEventListener("click", async (e) => {
    if (e.target === wrap || e.target.closest("[data-close]")) close();
    if (e.target.closest("[data-remove]") && onRemove) { close(); await onRemove(); }
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(wrap);
  wrap.querySelector("[data-close]").focus();
}

export const CATEGORIES = [
  ["confirmations", "Confirmations", "Hotel, transfer and experience vouchers"],
  ["tickets", "Tickets & travel", "Flights, trains and insurance"],
  ["receipts", "Receipts & invoices", "A record of every payment received"],
];
export function categoryLabel(c) { return c === "client" ? "Your documents" : (CATEGORIES.find((x) => x[0] === c) || [c, c])[1]; }

export async function uploadFile(tripId, category, file) {
  const path = `${tripId}/${category}/${uuid()}-${safeName(file.name)}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw error;
  return path;
}

export const KIND_TAG = { flight: "FLT", hotel: "HTL", transfer: "CAR", experience: "EXP", other: "RES" };

// ---------- in-page confirmation (browser pop-ups can be blocked, so we never rely on them) ----------
// askConfirm("Remove this?", { ok: "Remove", danger: true, typeToConfirm: "DELETE" }) → Promise<boolean>
export function askConfirm(message, { title = "Are you sure?", ok = "Yes, continue", cancel = "Cancel", danger = false, typeToConfirm = "" } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "overlay";
    wrap.innerHTML = `<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="cf-t" aria-describedby="cf-m" style="max-width:480px">
      <div style="padding:28px 28px 8px;display:flex;flex-direction:column;gap:12px">
        <h2 id="cf-t" style="font-size:28px">${esc(title)}</h2>
        <p id="cf-m" class="muted">${esc(message)}</p>
        ${typeToConfirm ? `<div class="field"><label for="cf-in">Type ${esc(typeToConfirm)} to confirm</label><input class="input" id="cf-in" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>` : ""}
      </div>
      <div class="df" style="border-top:0"><button class="btn line sm" type="button" data-cf="no">${esc(cancel)}</button>
        <button class="btn sm" type="button" data-cf="yes" ${typeToConfirm ? "disabled" : ""} ${danger ? 'style="background:#8A2E22;border-color:#8A2E22;color:#fff"' : ""}>${esc(ok)}</button></div></div>`;
    const yes = wrap.querySelector('[data-cf="yes"]'), input = wrap.querySelector("#cf-in");
    const done = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey, true); prev?.focus?.(); resolve(v); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      if (e.key === "Enter" && !yes.disabled && document.activeElement !== wrap.querySelector('[data-cf="no"]')) { e.preventDefault(); done(true); }
      if (e.key === "Tab") { // keep focus inside the box
        const f = [...wrap.querySelectorAll("button:not([disabled]), input")]; const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest('[data-cf="no"]')) done(false); else if (e.target.closest('[data-cf="yes"]') && !yes.disabled) done(true); });
    input?.addEventListener("input", () => { yes.disabled = input.value.trim().toUpperCase() !== typeToConfirm.toUpperCase(); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(wrap);
    (input || wrap.querySelector('[data-cf="no"]')).focus();
  });
}

// ---------- MRF photo set: rotates on the client sign-in and on itinerary PDF covers ----------
// Our own yacht photo plus Unsplash photos (free under the Unsplash License). Framing keeps the
// subject clear of the headline on the left.
const UNSPLASH = (id, w = 1400, h = 2000) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&h=${h}&q=80`;
export const PHOTOS = [
  { name: "Yacht on deep teal", url: new URL("sign-in.jpg", import.meta.url).href, size: "cover", pos: "center" },
  { name: "Overwater villas at dusk", url: UNSPLASH("photo-1620483829646-8fb1d8162108"), size: "115% auto", pos: "85% 38%" },
  { name: "Island at night", url: UNSPLASH("photo-1759862577214-447b51f1452d"), size: "cover", pos: "center" },
  { name: "Island villa on the reef", url: UNSPLASH("photo-1539223583194-b66100fa7273", 1800, 2600), size: "185% auto", pos: "0% 42%" },
  { name: "Yacht from above", url: UNSPLASH("photo-1528154291023-a6525fabe5b4", 1800, 2600), size: "170% auto", pos: "0% 50%" },
  { name: "Sandbar and dark sea", url: UNSPLASH("photo-1759861680699-1077ce446d06"), size: "cover", pos: "center" },
];
export const photoStyle = (ph) => `background-image:url('${ph.url}');background-size:${ph.size};background-position:${ph.pos};background-repeat:no-repeat`;
// Each photo shows for 7 seconds and crossfades into the next.
export function slidesHtml() {
  const n = PHOTOS.length, per = 7, total = n * per, fade = (1.4 / total) * 100, show = (per / total) * 100;
  const css = `@keyframes mrfSlide{0%{opacity:0}${fade.toFixed(2)}%{opacity:1}${show.toFixed(2)}%{opacity:1}${(show + fade).toFixed(2)}%{opacity:0}100%{opacity:0}}
    @keyframes mrfSlideFirst{0%{opacity:1}${show.toFixed(2)}%{opacity:1}${(show + fade).toFixed(2)}%{opacity:0}${(100 - fade).toFixed(2)}%{opacity:0}100%{opacity:1}}`;
  return `<style>${css}</style><div class="slides" aria-hidden="true">${PHOTOS.map((ph, i) =>
    `<i style="${photoStyle(ph)};animation:${i === 0 ? "mrfSlideFirst" : "mrfSlide"} ${total}s ${i * per}s infinite${i === 0 ? ";opacity:1" : ""}"></i>`).join("")}</div>`;
}
export function nextCoverPhoto() {
  let i = 0; try { i = (Number(localStorage.getItem("mrf-cover")) || 0) % PHOTOS.length; localStorage.setItem("mrf-cover", String(i + 1)); } catch {}
  return PHOTOS[i];
}
