// Cloudflare Worker: Telegram bot -> starts the GitHub "Record" workflow when an allowed person sends a stream link.
// Also hands the link and the Stop / Status / Split button presses to the running job.
//
// Secrets / variables (Worker -> Settings -> Variables and Secrets):
//   TG_TOKEN        bot token (secret)
//   WEBHOOK_SECRET  any long random text (secret), the same one you give to Telegram's setWebhook
//   GH_PAT          GitHub fine-grained token with "Actions: Read and write" on the repo (secret)
//   WORKER_KEY      any long random text (secret), the same one you put in the GitHub secret WORKER_KEY
//   REPO            "yourname/yourrepo"
//   ALLOWED         chat ids that may use the bot, comma separated. The FIRST one is the owner.
//   BRANCH          (optional) default "main"
//   WORKFLOW        (optional) default "record.yml"
// KV namespace binding named: KV

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    try {
      if (u.pathname === "/tg" && req.method === "POST") return await telegram(req, env);
      if (u.pathname === "/link") return await giveLink(req, env, u);
      if (u.pathname === "/cmd") return await giveCmds(req, env, u);
    } catch (e) {
      console.log("error", e && e.message);
      return new Response("error", { status: 500 });
    }
    return new Response("ok");
  },
};

async function tgApi(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const send = (env, chat, text) => tgApi(env, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true });
const keyOk = (req, env) => !!env.WORKER_KEY && req.headers.get("X-Key") === env.WORKER_KEY;

async function pushCmd(env, chat, cmd) {
  const k = "cmd:" + chat;
  const cur = JSON.parse((await env.KV.get(k)) || "[]");
  cur.push(cmd);
  await env.KV.put(k, JSON.stringify(cur), { expirationTtl: 600 });
}

async function telegram(req, env) {
  if (!env.WEBHOOK_SECRET || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const up = await req.json();
  if (up.update_id != null) {                                  // Telegram may send the same update twice: never start two runs
    if (await env.KV.get("upd:" + up.update_id)) return new Response("ok");
    await env.KV.put("upd:" + up.update_id, "1", { expirationTtl: 3600 });
  }
  const allowed = (env.ALLOWED || "").split(",").map((s) => s.trim()).filter(Boolean);
  const owner = allowed[0];

  if (up.callback_query) {                                     // a button was pressed
    const cq = up.callback_query;
    const chat = String((cq.message && cq.message.chat && cq.message.chat.id) ?? cq.from.id);
    if (!allowed.includes(chat) || !["status", "split", "stop"].includes(String(cq.data).split("@")[0])) {
      await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Not allowed" });
      return new Response("ok");
    }
    await pushCmd(env, chat, cq.data);
    await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id, text: String(cq.data).startsWith("stop") ? "Stopping... (up to a minute)" : "Sent (up to a minute)" });
    return new Response("ok");
  }

  const m = up.message;
  if (!m || !m.text) return new Response("ok");
  const chat = String(m.chat.id);
  const text = m.text.trim();

  if (!allowed.includes(chat)) {
    await send(env, chat, `⛔ You are not allowed to use this bot yet.\nYour chat id is <code>${esc(chat)}</code>\nSend this number to the owner so they can add you.`);
    return new Response("ok");
  }

  const cmd = text.split(/\s+/)[0].toLowerCase().split("@")[0];
  if (cmd === "/start" || cmd === "/help") {
    await send(env, chat, "🎬 <b>Recorder</b>\nSend me a stream link (.m3u8 or .ts, live or a finished archive) and I start recording on GitHub.\nYou can add a file name after the link, for example:\n<code>https://... Final_Match</code>\nCommands: /status /split /stop (they work while a recording runs).");
    return new Response("ok");
  }
  if (cmd === "/status" || cmd === "/split" || cmd === "/stop") {
    await pushCmd(env, chat, cmd.slice(1));
    await send(env, chat, "👌 Sent to your running recording (it can take up to a minute). If nothing is recording, nothing happens.");
    return new Response("ok");
  }

  const found = text.match(URL_RE);
  if (!found) {
    await send(env, chat, "Send me the stream link (.m3u8 or .ts address) as a message.");
    return new Response("ok");
  }
  const link = found[0].replace(/[)>,]+$/, "");
  const name = text.replace(found[0], "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 40);

  const ticket = crypto.randomUUID();
  await env.KV.put("link:" + ticket, link, { expirationTtl: 86400 });   // the link never goes to GitHub, only this ticket
  const inputs = { ticket, chat, also: "" };
  if (name) inputs.name = name;
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/${env.WORKFLOW || "record.yml"}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_PAT}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "recorder-worker", "content-type": "application/json",
    },
    body: JSON.stringify({ ref: env.BRANCH || "main", inputs }),
  });
  if (r.status === 204) {
    await send(env, chat, "✅ Got the link. Recording is starting on GitHub. You will get a message here in about a minute.");
  } else {
    const t = (await r.text()).slice(0, 200);
    await send(env, chat, `❌ Could not start the recording (GitHub said ${r.status}).\n<code>${esc(t)}</code>\nTell the owner.`);
  }
  return new Response("ok");
}

async function giveLink(req, env, u) {
  if (!keyOk(req, env)) return json({}, 403);
  const v = await env.KV.get("link:" + (u.searchParams.get("ticket") || ""));
  return v ? json({ url: v }) : json({}, 404);
}

async function giveCmds(req, env, u) {
  if (!keyOk(req, env)) return json({}, 403);
  const run = u.searchParams.get("run") || "";
  const meRaw = u.searchParams.get("me");                       // an older gh_record.py sends no "me": then typed commands go to every run of that chat
  const out = [];
  for (const c of (u.searchParams.get("chats") || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const k = "cmd:" + c;
    const v = await env.KV.get(k);
    if (!v) continue;
    const keep = [];
    for (const x of JSON.parse(v)) {
      const at = x.indexOf("@");
      // a button carries its run id: only that run takes it. A typed command goes only to the run that chat started.
      const mine = at >= 0 ? x.slice(at + 1) === run : (meRaw === null || c === meRaw);
      if (mine) { if (!out.includes(x.split("@")[0])) out.push(x.split("@")[0]); } else keep.push(x);
    }
    if (keep.length) await env.KV.put(k, JSON.stringify(keep), { expirationTtl: 600 });
    else await env.KV.delete(k);
  }
  return json({ cmds: out });
}
