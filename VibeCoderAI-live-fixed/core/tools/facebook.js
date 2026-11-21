"use strict"
/**
 * Facebook tools for the agent, offered while the Facebook connector is signed
 * in. They work on the signed-in user's own Pages, Messenger, Business and ad
 * accounts.
 *
 * Reading never asks. Anything other people will see, anything that spends
 * money, and anything that deletes always asks the user first (even in Full
 * Access): publishing posts, replying publicly, sending messages, turning ads
 * on, raising budgets, deleting. Drafts and paused ads follow the normal
 * permission mode. There is no way to delete the Facebook account.
 */

const MAX = 24000
const clip = (s, n = MAX) => (s.length <= n ? s : `${s.slice(0, n)}\n… [${s.length - n} more characters cut; ask for less]`)
const out = (data) => clip(JSON.stringify(data, null, 2))

function fb(ctx) {
  const c = ctx && ctx.engine && ctx.engine.connectors && ctx.engine.connectors.facebook
  if (!c || !c.connected()) throw new Error("Facebook is not connected. Ask the user to sign in under Connectors → Facebook (CLI: vibe connectors facebook connect). Nothing was done.")
  return c
}

async function confirmCritical(ctx, what) {
  const ok = typeof ctx.askPermission === "function" && await ctx.askPermission({ tool: "facebook", subject: `Allow the agent to ${what} on Facebook?`, neverPersist: true, forceAsk: true, critical: true })
  if (!ok) throw new Error(`The user did not allow this: ${what}. Do not retry it; ask the user what to do.`)
}

const idOf = (v, label) => {
  const s = String(v == null ? "" : v).trim()
  if (!/^[\w.-]+$/.test(s)) throw new Error(`"${label}" must be a Facebook id (numbers, or act_123 for an ad account); got "${v}". Nothing was done.`)
  return s
}
const actOf = (v) => { const s = idOf(v, "ad_account"); return s.startsWith("act_") ? s : `act_${s}` }
const short = (s, n = 140) => String(s || "").replace(/\s+/g, " ").slice(0, n)

const tool = (name, description, properties, required, perm, run) => ({
  name, description, parameters: { type: "object", properties, required }, connector: "facebook",
  perm: (a) => ({ tool: "facebook", subject: perm(a) }), paths: () => [], run,
})
const pageProp = { type: "string", description: "Page id from facebook_pages" }

const ALL = [
  tool("facebook_pages", "List the Facebook Pages the signed-in user manages (id, name, category, followers, what they may do).",
    {}, [], () => "read pages",
    async (a, ctx) => {
      const data = await fb(ctx).api("GET", "/me/accounts", { fields: "id,name,category,followers_count,tasks", limit: 100 })
      const rows = data.data || []
      return rows.length ? rows.map((p) => `${p.id} · ${p.name} · ${p.category || ""}${p.followers_count != null ? ` · ${p.followers_count} followers` : ""} · can: ${(p.tasks || []).join(", ")}`).join("\n") : "This account manages no Facebook Pages (or did not allow Page access when signing in)."
    }),

  tool("facebook_page_posts", "Read the latest posts of a Page with likes/comments counts.",
    { page: pageProp, limit: { type: "integer", description: "default 10" } }, ["page"], () => "read posts",
    async (a, ctx) => {
      const c = fb(ctx)
      const data = await c.asPage(idOf(a.page, "page"), "GET", `/${idOf(a.page, "page")}/posts`, { fields: "id,message,created_time,permalink_url,is_published,comments.summary(true).limit(0),reactions.summary(true).limit(0)", limit: Math.min(50, Number(a.limit) || 10) })
      const rows = data.data || []
      return rows.length ? rows.map((p) => `${p.id} · ${String(p.created_time).slice(0, 10)} · ${p.reactions?.summary?.total_count ?? 0} reactions · ${p.comments?.summary?.total_count ?? 0} comments\n  ${short(p.message) || "(no text)"}\n  ${p.permalink_url || ""}`).join("\n") : "No posts on this Page yet."
    }),

  tool("facebook_create_post", "Write a post on a Page. publish=true posts it publicly now (always asks the user first); publish=false saves an unpublished draft. Optional link or scheduled time.",
    { page: pageProp, message: { type: "string" }, link: { type: "string", description: "Optional URL to attach" }, publish: { type: "boolean", description: "true = public now (asks first); false = draft (default)" }, schedule_time: { type: "string", description: "Optional ISO date/time to publish later (10 min – 30 days ahead)" } }, ["page", "message"],
    (a) => `write post ${a.page}`,
    async (a, ctx) => {
      const c = fb(ctx)
      const page = idOf(a.page, "page")
      const scheduled = a.schedule_time ? Math.floor(Date.parse(a.schedule_time) / 1000) : 0
      if (a.schedule_time && !Number.isFinite(scheduled)) throw new Error('"schedule_time" is not a valid date. Nothing was done.')
      const live = a.publish === true || !!scheduled
      if (live) await confirmCritical(ctx, `${scheduled ? `schedule a post for ${new Date(scheduled * 1000).toLocaleString()}` : "publish a post now"} on Page ${page}: "${short(a.message, 200)}"`)
      const r = await c.asPage(page, "POST", `/${page}/feed`, { message: String(a.message), ...(a.link ? { link: a.link } : {}), ...(scheduled ? { published: false, scheduled_publish_time: scheduled } : live ? {} : { published: false }) })
      return `${scheduled ? "Scheduled" : live ? "Published" : "Saved as an unpublished draft"}: post ${r.id}.${live ? "" : " Publish it later with facebook_create_post publish=true, or from Facebook."}`
    }),

  tool("facebook_upload_video", "Upload a video file from the project to a Page, as a normal video or as a Reel (reel=true: vertical 9:16 MP4, 3-90 seconds, at least 540x960). publish=true makes it public now (always asks the user first); publish=false (default) uploads it unpublished / as a draft. Then check processing with facebook_video_status.",
    { page: pageProp, file: { type: "string", description: "Path of the .mp4 file (inside the project)" }, reel: { type: "boolean", description: "true = upload as a Reel" }, title: { type: "string" }, description: { type: "string", description: "The post text shown with the video" }, publish: { type: "boolean", description: "true = public now (asks first); false = unpublished draft (default)" } }, ["page", "file"],
    (a) => `write video ${a.page}`,
    async (a, ctx) => {
      const c = fb(ctx)
      const page = idOf(a.page, "page")
      const path = require("path")
      const file = path.resolve((ctx && ctx.cwd) || process.cwd(), String(a.file || ""))
      if (!/\.(mp4|mov|m4v)$/i.test(file)) throw new Error('"file" must be an .mp4 (or .mov) video. Nothing was uploaded.')
      const live = a.publish === true
      if (live) await confirmCritical(ctx, `publish the ${a.reel ? "Reel" : "video"} "${path.basename(file)}" on Page ${page} now${a.description ? ` with the text "${short(a.description, 160)}"` : ""}`)
      const r = a.reel
        ? await c.uploadReel(page, file, { title: a.title, description: a.description, state: live ? "PUBLISHED" : "DRAFT" })
        : await c.uploadVideo(page, file, { title: a.title, description: a.description, published: live })
      return `${a.reel ? "Reel" : "Video"} uploaded: ${r.id} (${live ? "published — Facebook is processing it" : "unpublished draft"}). Check it with facebook_video_status page=${page} video_id=${r.id}.`
    }),

  tool("facebook_video_status", "Check an uploaded video or Reel: processing state (processing, ready, error…) and its link.",
    { page: pageProp, video_id: { type: "string" } }, ["page", "video_id"], () => "read video",
    async (a, ctx) => {
      const d = await fb(ctx).videoStatus(idOf(a.page, "page"), idOf(a.video_id, "video_id"))
      const s = d.status || {}
      const phase = (k) => (s[k] && s[k].status ? `${k.replace("_phase", "")}: ${s[k].status}` : "")
      return [`Video ${a.video_id}: ${s.video_status || "unknown"}`, [phase("uploading_phase"), phase("processing_phase"), phase("publishing_phase")].filter(Boolean).join(" · "), d.permalink_url ? `https://www.facebook.com${d.permalink_url.startsWith("/") ? "" : "/"}${d.permalink_url.replace(/^https:\/\/www\.facebook\.com\/?/, "")}` : ""].filter(Boolean).join("\n")
    }),

  tool("facebook_comments", "Read the comments of a post (or the replies of a comment).",
    { id: { type: "string", description: "Post id or comment id" }, limit: { type: "integer" } }, ["id"], () => "read comments",
    async (a, ctx) => {
      const id = idOf(a.id, "id")
      const page = id.includes("_") ? id.split("_")[0] : null
      const c = fb(ctx)
      const params = { fields: "id,from,message,created_time,like_count,comment_count", limit: Math.min(100, Number(a.limit) || 30), order: "reverse_chronological" }
      const data = page ? await c.asPage(page, "GET", `/${id}/comments`, params) : await c.api("GET", `/${id}/comments`, params)
      const rows = data.data || []
      return rows.length ? rows.map((m) => `${m.id} · ${m.from?.name || "someone"} · ${String(m.created_time).slice(0, 16)} · ${m.like_count || 0} likes${m.comment_count ? ` · ${m.comment_count} replies` : ""}\n  ${short(m.message, 300)}`).join("\n") : "No comments."
    }),

  tool("facebook_reply_comment", "Reply publicly to a comment as the Page. Always asks the user first.",
    { page: pageProp, comment_id: { type: "string" }, message: { type: "string" } }, ["page", "comment_id", "message"],
    (a) => `write reply ${a.page}`,
    async (a, ctx) => {
      const c = fb(ctx)
      await confirmCritical(ctx, `reply publicly to comment ${a.comment_id}: "${short(a.message, 200)}"`)
      const r = await c.asPage(idOf(a.page, "page"), "POST", `/${idOf(a.comment_id, "comment_id")}/comments`, { message: String(a.message) })
      return `Replied (comment ${r.id}).`
    }),

  tool("facebook_messages", "Read a Page's Messenger conversations, or the messages of one conversation.",
    { page: pageProp, conversation_id: { type: "string", description: "Optional: read this conversation's messages" }, limit: { type: "integer" } }, ["page"], () => "read messages",
    async (a, ctx) => {
      const c = fb(ctx)
      const page = idOf(a.page, "page")
      if (a.conversation_id) {
        const data = await c.asPage(page, "GET", `/${idOf(a.conversation_id, "conversation_id")}/messages`, { fields: "id,from,to,message,created_time", limit: Math.min(50, Number(a.limit) || 20) })
        return (data.data || []).map((m) => `${String(m.created_time).slice(0, 16)} · ${m.from?.name || m.from?.id}: ${short(m.message, 400)}`).join("\n") || "No messages."
      }
      const data = await c.asPage(page, "GET", `/${page}/conversations`, { fields: "id,participants,updated_time,unread_count,snippet", limit: Math.min(50, Number(a.limit) || 20) })
      return (data.data || []).map((t) => `${t.id} · ${(t.participants?.data || []).map((p) => `${p.name} (${p.id})`).join(", ")} · ${String(t.updated_time).slice(0, 16)}${t.unread_count ? ` · ${t.unread_count} unread` : ""}\n  ${short(t.snippet)}`).join("\n") || "No conversations."
    }),

  tool("facebook_send_message", "Send a Messenger message from a Page to a person who wrote to the Page. Facebook's rule: a normal reply works within 24 hours of the person's last message; with human_agent=true a person (the user, through the agent) can reply up to 7 days after it. Messages from a personal profile are not possible through Facebook's API. Always asks the user first.",
    { page: pageProp, recipient_id: { type: "string", description: "The person's id (from facebook_messages: the participant who is not the Page)" }, text: { type: "string" }, human_agent: { type: "boolean", description: "Reply 1-7 days after their last message (Human Agent tag)" } }, ["page", "recipient_id", "text"],
    (a) => `write message ${a.page}`,
    async (a, ctx) => {
      const c = fb(ctx)
      await confirmCritical(ctx, `send a Messenger message to ${a.recipient_id}: "${short(a.text, 200)}"`)
      const page = idOf(a.page, "page")
      const base = { recipient: { id: idOf(a.recipient_id, "recipient_id") }, message: { text: String(a.text) } }
      try {
        const r = await c.asPage(page, "POST", `/${page}/messages`, a.human_agent ? { ...base, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : { ...base, messaging_type: "RESPONSE" })
        return `Message sent (${r.message_id || "ok"}).`
      } catch (e) {
        const m = String(e.message || e)
        if (/outside of allowed window|2018278|24 hour/i.test(m) && !a.human_agent) throw new Error(`${m} Their last message is older than 24 hours: send it again with human_agent=true (works up to 7 days after their last message).`)
        if (/permission|\(#10\)|\(#200\)|pages_messaging/i.test(m)) throw new Error(`${m} Messenger needs the "pages_messaging" permission (and "human_agent" for late replies) in the Facebook sign-in. Ask the user to add them in the Meta app's Login configuration and sign in to Facebook again in Connectors.`)
        throw e
      }
    }),

  tool("facebook_edit_post", "Change the text of a Page post the Page published. Always asks the user first (people will see the change).",
    { page: pageProp, post_id: { type: "string", description: "Post id, e.g. 555_123 (from facebook_page_posts)" }, message: { type: "string", description: "The new text" } }, ["page", "post_id", "message"],
    (a) => `write post ${a.page}`,
    async (a, ctx) => {
      const page = idOf(a.page, "page")
      const id = idOf(a.post_id, "post_id")
      await confirmCritical(ctx, `change post ${id} on Page ${page} to: "${short(a.message, 200)}"`)
      await fb(ctx).asPage(page, "POST", `/${id}`, { message: String(a.message) })
      return `Post ${id} updated.`
    }),

  tool("facebook_delete", "Delete something the Page owns: a post, a comment, a photo or a video. It cannot be undone, so the user is always asked first. (The Facebook account itself can never be deleted.)",
    { page: pageProp, id: { type: "string", description: "Id of the post / comment / photo / video" }, what: { type: "string", enum: ["post", "comment", "photo", "video"], description: "What it is (shown to the user in the question)" } }, ["page", "id"],
    (a) => `write delete ${a.page}`,
    async (a, ctx) => {
      const page = idOf(a.page, "page")
      const id = idOf(a.id, "id")
      if (id === page) throw new Error("A Page or the account itself cannot be deleted here. Nothing was done.")
      await confirmCritical(ctx, `permanently delete ${a.what || "item"} ${id} from Page ${page} (cannot be undone)`)
      await fb(ctx).asPage(page, "DELETE", `/${id}`, {})
      return `Deleted ${a.what || "item"} ${id}.`
    }),

  tool("facebook_hide_comment", "Hide a comment on a Page post (hide=true; the writer and their friends still see it, others do not) or show it again (hide=false). Asks the user first.",
    { page: pageProp, comment_id: { type: "string" }, hide: { type: "boolean", description: "true = hide (default), false = show again" } }, ["page", "comment_id"],
    (a) => `write comment ${a.page}`,
    async (a, ctx) => {
      const page = idOf(a.page, "page")
      const id = idOf(a.comment_id, "comment_id")
      const hide = a.hide !== false
      await confirmCritical(ctx, `${hide ? "hide" : "show again"} comment ${id}`)
      await fb(ctx).asPage(page, "POST", `/${id}`, { is_hidden: hide })
      return `Comment ${id} ${hide ? "hidden" : "visible again"}.`
    }),

  tool("facebook_upload_photo", "Post a photo file from the project on a Page, with an optional caption. publish=true makes it public now (always asks first); publish=false (default) uploads it unpublished.",
    { page: pageProp, file: { type: "string", description: "Path of a .jpg / .png / .gif / .webp (inside the project)" }, caption: { type: "string" }, publish: { type: "boolean" } }, ["page", "file"],
    (a) => `write photo ${a.page}`,
    async (a, ctx) => {
      const page = idOf(a.page, "page")
      const path = require("path")
      const file = path.resolve((ctx && ctx.cwd) || process.cwd(), String(a.file || ""))
      if (!/\.(jpe?g|png|gif|webp)$/i.test(file)) throw new Error('"file" must be a .jpg, .png, .gif or .webp image. Nothing was uploaded.')
      if (a.publish === true) await confirmCritical(ctx, `publish the photo "${path.basename(file)}" on Page ${page}${a.caption ? ` with "${short(a.caption, 160)}"` : ""}`)
      const r = await fb(ctx).uploadPhoto(page, file, { caption: a.caption, published: a.publish === true })
      return `Photo uploaded: ${r.id}${r.postId ? ` (post ${r.postId})` : ""}, ${r.published ? "published" : "unpublished"}.`
    }),

  tool("facebook_update_page", "Change a Page's public info: about (short description), description, phone, website, emails, general_info. Asks the user first.",
    { page: pageProp, about: { type: "string" }, description: { type: "string" }, phone: { type: "string" }, website: { type: "string" }, emails: { type: "array", items: { type: "string" } }, general_info: { type: "string" } }, ["page"],
    (a) => `write page ${a.page}`,
    async (a, ctx) => {
      const page = idOf(a.page, "page")
      const fields = {}
      for (const k of ["about", "description", "phone", "website", "general_info"]) if (a[k] != null && a[k] !== "") fields[k] = String(a[k])
      if (Array.isArray(a.emails) && a.emails.length) fields.emails = a.emails.map(String)
      if (!Object.keys(fields).length) throw new Error("Give at least one field to change (about, description, phone, website, emails, general_info). Nothing was done.")
      await confirmCritical(ctx, `change Page ${page}: ${Object.entries(fields).map(([k, v]) => `${k}="${short(Array.isArray(v) ? v.join(", ") : v, 80)}"`).join(", ")}`)
      await fb(ctx).asPage(page, "POST", `/${page}`, fields)
      return `Page ${page} updated: ${Object.keys(fields).join(", ")}.`
    }),

  tool("facebook_insights", "Read Page or post statistics (reach, engagement, followers…). Default: last 28 days of key Page metrics.",
    { id: { type: "string", description: "Page id or post id" }, metrics: { type: "string", description: "Comma-separated metric names (optional)" }, period: { type: "string", enum: ["day", "week", "days_28", "lifetime"] } }, ["id"], () => "read insights",
    async (a, ctx) => {
      const c = fb(ctx)
      const id = idOf(a.id, "id")
      const isPost = id.includes("_")
      const metric = a.metrics || (isPost ? "post_impressions,post_impressions_unique,post_engaged_users,post_clicks" : "page_impressions,page_impressions_unique,page_post_engagements,page_fans")
      const page = isPost ? id.split("_")[0] : id
      const data = await c.asPage(page, "GET", `/${id}/insights`, { metric, ...(isPost ? {} : { period: a.period || "days_28" }) })
      return (data.data || []).map((m) => `${m.name} (${m.period}): ${(m.values || []).map((v) => typeof v.value === "object" ? JSON.stringify(v.value) : v.value).join(", ")}`).join("\n") || "No statistics returned."
    }),

  tool("facebook_ad_accounts", "List the ad accounts the user can use (id, name, currency, status, amount spent).",
    {}, [], () => "read ads",
    async (a, ctx) => {
      const data = await fb(ctx).api("GET", "/me/adaccounts", { fields: "id,name,currency,account_status,amount_spent,balance,business", limit: 100 })
      const rows = data.data || []
      return rows.length ? rows.map((r) => `${r.id} · ${r.name} · ${r.currency} · status ${r.account_status} · spent ${r.amount_spent}${r.business ? ` · business ${r.business.name}` : ""}`).join("\n") : "No ad accounts are available to this sign-in."
    }),

  tool("facebook_ads", "List campaigns, ad sets or ads of an ad account with status, budget and recent results.",
    { ad_account: { type: "string", description: "act_… id from facebook_ad_accounts" }, level: { type: "string", enum: ["campaigns", "adsets", "ads"], description: "default campaigns" } }, ["ad_account"], () => "read ads",
    async (a, ctx) => {
      const level = ["campaigns", "adsets", "ads"].includes(a.level) ? a.level : "campaigns"
      const fields = level === "campaigns" ? "id,name,objective,status,effective_status,daily_budget,lifetime_budget,insights.date_preset(last_7d){spend,impressions,clicks,ctr}" : level === "adsets" ? "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,insights.date_preset(last_7d){spend,impressions,clicks}" : "id,name,status,effective_status,adset_id,insights.date_preset(last_7d){spend,impressions,clicks}"
      const data = await fb(ctx).api("GET", `/${actOf(a.ad_account)}/${level}`, { fields, limit: 100 })
      const rows = data.data || []
      return rows.length ? rows.map((r) => { const i = r.insights?.data?.[0] || {}; return `${r.id} · ${r.name} · ${r.effective_status || r.status}${r.objective ? ` · ${r.objective}` : ""}${r.daily_budget ? ` · daily budget ${r.daily_budget}` : ""}${r.lifetime_budget ? ` · lifetime budget ${r.lifetime_budget}` : ""} · last 7 days: spend ${i.spend || 0}, ${i.impressions || 0} impressions, ${i.clicks || 0} clicks` }).join("\n") : `No ${level} in this ad account.`
    }),

  tool("facebook_create_campaign", "Create an ad campaign. It is created PAUSED (no money is spent) unless status=ACTIVE, which always asks the user first.",
    { ad_account: { type: "string" }, name: { type: "string" }, objective: { type: "string", description: "e.g. OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES, OUTCOME_AWARENESS" }, status: { type: "string", enum: ["PAUSED", "ACTIVE"] }, daily_budget: { type: "integer", description: "Optional campaign daily budget in the account currency's smallest unit (e.g. cents)" } }, ["ad_account", "name", "objective"],
    (a) => `write campaign ${a.ad_account}`,
    async (a, ctx) => {
      const status = a.status === "ACTIVE" ? "ACTIVE" : "PAUSED"
      if (status === "ACTIVE" || a.daily_budget) await confirmCritical(ctx, `create campaign "${a.name}" ${status === "ACTIVE" ? "and start spending" : "(paused)"}${a.daily_budget ? ` with daily budget ${a.daily_budget}` : ""}`)
      const r = await fb(ctx).api("POST", `/${actOf(a.ad_account)}/campaigns`, { name: String(a.name), objective: String(a.objective), status, special_ad_categories: [], ...(a.daily_budget ? { daily_budget: Number(a.daily_budget) } : {}) })
      return `Created campaign ${r.id} (${status}). Next: create an ad set and ad (facebook_api), then turn it on with facebook_set_status when the user agrees.`
    }),

  tool("facebook_set_status", "Turn a campaign, ad set or ad on (ACTIVE — spends money, always asks) or off (PAUSED). Can also change its daily budget (asks).",
    { id: { type: "string", description: "Campaign, ad set or ad id" }, status: { type: "string", enum: ["ACTIVE", "PAUSED"] }, daily_budget: { type: "integer", description: "Optional new daily budget (smallest currency unit)" } }, ["id"],
    (a) => `write status ${a.id}`,
    async (a, ctx) => {
      const id = idOf(a.id, "id")
      if (a.status === "ACTIVE" || a.daily_budget != null) await confirmCritical(ctx, `${a.status === "ACTIVE" ? "turn ON (start spending) " : ""}${a.daily_budget != null ? `set the daily budget to ${a.daily_budget} for ` : ""}${id}`)
      const params = { ...(a.status ? { status: a.status } : {}), ...(a.daily_budget != null ? { daily_budget: Number(a.daily_budget) } : {}) }
      if (!Object.keys(params).length) throw new Error("Give status (ACTIVE or PAUSED) and/or daily_budget. Nothing was done.")
      await fb(ctx).api("POST", `/${id}`, params)
      return `Updated ${id}: ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(", ")}.`
    }),

  tool("facebook_api", "Call any other Facebook Graph API endpoint (https://developers.facebook.com/docs/graph-api) when no other facebook_ tool fits — e.g. ad sets, ads, creatives, audiences, Business Manager, Page settings. GET only reads; POST and DELETE always ask the user first. Use page to act as a Page.",
    { method: { type: "string", enum: ["GET", "POST", "DELETE"] }, path: { type: "string", description: "e.g. /act_123/adsets or /123456/feed" }, params: { type: "object", description: "Query (GET/DELETE) or form fields (POST)" }, page: { type: "string", description: "Optional Page id to call as that Page" } }, ["method", "path"],
    (a) => (String(a.method || "GET").toUpperCase() === "GET" ? "read api" : `write api ${a.path}`),
    async (a, ctx) => {
      const c = fb(ctx)
      const method = String(a.method || "GET").toUpperCase()
      const p = String(a.path || "")
      if (!p.startsWith("/")) throw new Error('"path" must start with / (for example /me/accounts). Nothing was done.')
      // The account itself is never deleted or changed through the agent.
      if (method === "DELETE" && /^\/(me|\d+)\/?$/.test(p.split("?")[0])) throw new Error("Deleting a Facebook account or user object is not allowed. Nothing was done.")
      if (method !== "GET") await confirmCritical(ctx, `${method} ${p}${a.params ? ` with ${short(JSON.stringify(a.params), 200)}` : ""}`)
      const data = a.page ? await c.asPage(idOf(a.page, "page"), method, p, a.params || {}) : await c.api(method, p, a.params || {})
      return data == null ? `${method} ${p}: done.` : out(data)
    }),
]

// The video file is a path: outside the project it needs the user's OK like any other path.
for (const name of ["facebook_upload_video", "facebook_upload_photo"]) ALL.find((t) => t.name === name).paths = (a, ctx) => [require("path").resolve((ctx && ctx.cwd) || process.cwd(), String((a && a.file) || ""))]

module.exports = { ALL }
