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
