/* 云端同步：把 chrome.storage.local.jds 里的记录（含 statusHistory）
 * upsert 进 career-web 用的同一套 Supabase 表（career_jds / career_status_history）。
 *
 * ⚠️ 架构取舍：不装 @supabase/supabase-js SDK，手写基于 fetch 的 REST 客户端。
 *   理由和 lib/llm.js 是同一个——扩展坚持零构建，SDK 要么得打包要么得
 *   从 CDN 远程加载脚本，而 MV3 的默认 CSP 禁止扩展页面执行远程脚本。
 *   PostgREST（Supabase 的 REST 层）本来就是给 fetch() 直接调用设计的，
 *   手写客户端反而更贴合"你的数据只在你的浏览器和你的项目之间流动"这条边界。
 *
 * ⚠️ 登录方式选邮箱+密码，不选魔法链接：
 *   魔法链接的回调需要处理跳转到扩展页面（chrome-extension://…），
 *   这在 MV3 里要绕一圈（重定向白名单、tabs 监听），对个人工具不值得。
 *   邮箱+密码一次请求拿到 token，零跳转。前提是你已经在 career-web 里
 *   登录后用「设置同步密码」功能给这个账号加过密码（同一个 auth.users，
 *   RLS 按 auth.uid() 判断，跟你用哪种方式登录无关）。
 */

const DEFAULTS = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  syncEmail: "",
  // accessToken/refreshToken/expiresAt 由登录流程自动写入，不需要用户手填
  accessToken: "",
  refreshToken: "",
  expiresAt: 0,
};

export async function getSyncSettings() {
  const s = await chrome.storage.local.get({ sync: {} });
  return { ...DEFAULTS, ...(s.sync || {}) };
}

async function saveSyncSettings(patch) {
  const cur = await getSyncSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ sync: next });
  return next;
}

export function isSyncConfigured(s) {
  return !!(s.supabaseUrl && s.supabaseAnonKey);
}

export function isLoggedIn(s) {
  return !!(s.accessToken && s.expiresAt > Date.now());
}

/** 请求访问 Supabase 域名的权限——optional_host_permissions 声明了但不会自动生效，
 *  必须在用户手势里显式 request 一次，Chrome 才会真的放行跨域请求。 */
export async function ensureHostPermission(url) {
  const origin = new URL(url).origin + "/*";
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  return chrome.permissions.request({ origins: [origin] });
}

function authUrl(base, path) {
  return base.replace(/\/$/, "") + "/auth/v1" + path;
}
function restUrl(base, path) {
  return base.replace(/\/$/, "") + "/rest/v1" + path;
}

/** 邮箱+密码登录，拿 access_token / refresh_token */
export async function login(email, password) {
  const s = await getSyncSettings();
  if (!isSyncConfigured(s)) throw new Error("NO_CONFIG");
  await ensureHostPermission(s.supabaseUrl);

  const resp = await fetch(authUrl(s.supabaseUrl, "/token?grant_type=password"), {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: s.supabaseAnonKey },
    body: JSON.stringify({ email, password }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error("LOGIN_FAILED:" + resp.status + ":" + t.slice(0, 200));
  }
  const data = await resp.json();
  await saveSyncSettings({
    syncEmail: email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60000, // 提前 1 分钟过期，留刷新余量
  });
  return true;
}

export async function logout() {
  await saveSyncSettings({ accessToken: "", refreshToken: "", expiresAt: 0 });
}

async function refreshIfNeeded(s) {
  if (isLoggedIn(s)) return s;
  if (!s.refreshToken) throw new Error("NOT_LOGGED_IN");
  const resp = await fetch(authUrl(s.supabaseUrl, "/token?grant_type=refresh_token"), {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: s.supabaseAnonKey },
    body: JSON.stringify({ refresh_token: s.refreshToken }),
  });
  if (!resp.ok) throw new Error("REFRESH_FAILED");
  const data = await resp.json();
  return saveSyncSettings({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60000,
  });
}

async function authedFetch(s, url, opts) {
  const headers = {
    apikey: s.supabaseAnonKey,
    Authorization: "Bearer " + s.accessToken,
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  return fetch(url, { ...opts, headers });
}

/* ── 删除墓碑 ─────────────────────────────────────────────────
 *
 * 为什么需要墓碑：syncAll 只做 upsert、刻意不从"本地没有了"推断删除
 * （见上面 syncAll 的注释——网络抖动导致的空列表被误当成"用户真的清空了"
 * 是不可逆的损失）。但"我手动删掉这一条"是**显式意图**，云端应该跟着删。
 *
 * 这两件事的区别是：一个是从差异推断，一个是用户点了删除按钮。
 * 所以显式删除单独记一份 key 列表（墓碑），下次同步时执行，
 * 成功后清掉。删除时如果没登录/断网，墓碑会一直留着直到同步成功——
 * 不会出现"本地删了、云端还在、工作台照样显示"的鬼影。
 */
export async function addTombstone(jobKey) {
  const { deletedKeys = [] } = await chrome.storage.local.get({ deletedKeys: [] });
  if (!deletedKeys.includes(jobKey)) {
    deletedKeys.push(jobKey);
    await chrome.storage.local.set({ deletedKeys });
  }
}

export async function getTombstones() {
  const { deletedKeys = [] } = await chrome.storage.local.get({ deletedKeys: [] });
  return deletedKeys;
}

/** 在云端删掉这些 key，并写一条云端墓碑。返回成功处理完的 key。
 *
 *  ⚠️ 云端墓碑（career_deleted_jds）是给**其他端**看的：
 *  工作台读它才知道这条被插件删了；不写的话工作台那边照样显示。
 *  顺序是「先写墓碑再删记录」——反过来的话中途失败会留下
 *  "记录没了但没有删除凭证"的状态，其他端无从得知。 */
async function flushTombstones(s, keys) {
  const done = [];
  for (const key of keys) {
    const tomb = await authedFetch(
      s,
      restUrl(s.supabaseUrl, "/career_deleted_jds?on_conflict=user_id,job_key"),
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          job_key: key,
          deleted_at: new Date().toISOString(),
          deleted_by: "扩展",
        }),
      }
    );
    if (!tomb.ok) continue; // 墓碑没写上就不动记录，下次重试

    const q = `?job_key=eq.${encodeURIComponent(key)}`;
    const [a, b] = await Promise.all([
      authedFetch(s, restUrl(s.supabaseUrl, "/career_status_history" + q), { method: "DELETE" }),
      authedFetch(s, restUrl(s.supabaseUrl, "/career_jds" + q), { method: "DELETE" }),
    ]);
    // 两边都成功才算删干净。只删了历史没删本体的话下次还得重来，
    // 所以本地墓碑先不清——宁可重试一次，也不要留半条记录。
    if (a.ok && b.ok) done.push(key);
  }
  return done;
}

/** 读云端墓碑，把本地对应记录清掉。返回 {removed, revived}。
 *
 * 这是三端同步里最容易出错的一环。要点：
 *
 * 1. **为什么不能靠"云端没有这条"来判断**：那和"这条从来没同步过"
 *    在数据上无法区分。靠差异推断的话，一条刚采集还没同步的新记录
 *    会被当成"云端删过"而被本地清掉。
 *
 * 2. **删完又重新采集怎么办**：比较时间。本地记录的采集时间（ts）
 *    比墓碑的 deleted_at 晚 → 说明是重新采的，墓碑作废（顺手删掉云端
 *    那条墓碑，否则它会一直挡着这个岗位）。早于墓碑 → 该删。
 *    没有这个比较，你删掉一个岗位后就再也无法重新采集它了。
 */
async function pullDeletions(s) {
  const resp = await authedFetch(
    s,
    restUrl(s.supabaseUrl, "/career_deleted_jds?select=job_key,deleted_at"),
    { method: "GET" }
  );
  if (!resp.ok) return { removed: 0, revived: 0, ok: false };
  const tombs = await resp.json().catch(() => []);
  if (!Array.isArray(tombs) || !tombs.length) return { removed: 0, revived: 0, ok: true };

  const { jds = [] } = await chrome.storage.local.get({ jds: [] });
  const byKey = new Map(jds.map((j) => [j.key, j]));

  const toRemove = [];
  const staleTombs = [];
  for (const t of tombs) {
    const local = byKey.get(t.job_key);
    if (!local) continue; // 本地没有，不用管
    const localTs = Date.parse(String(local.ts || "").replace(" ", "T"));
    const tombTs = Date.parse(t.deleted_at);
    if (Number.isFinite(localTs) && Number.isFinite(tombTs) && localTs > tombTs) {
      staleTombs.push(t.job_key); // 删完又重新采集了
    } else {
      toRemove.push(t.job_key);
    }
  }

  if (toRemove.length) {
    await chrome.storage.local.set({ jds: jds.filter((j) => !toRemove.includes(j.key)) });
  }
  // 作废的墓碑要从云端删掉，否则它会永久挡住这个岗位
  for (const key of staleTombs) {
    await authedFetch(
      s,
      restUrl(s.supabaseUrl, `/career_deleted_jds?job_key=eq.${encodeURIComponent(key)}`),
      { method: "DELETE" }
    );
  }
  return { removed: toRemove.length, revived: staleTombs.length, ok: true };
}

/**
 * 把本地 JD（含 statusHistory）同步进 career_jds + career_status_history，
 * 并执行积压的删除墓碑。
 *
 * 删除的两种来源要分清：
 *   · **不做**从差异推断的删除——"本地没有这条了"不代表要删云端，
 *     网络抖动导致的空列表被误当成"用户真的清空了"是不可逆的损失。
 *   · **做**显式删除——用户在弹窗里点了删除按钮，那是明确意图，
 *     记进墓碑并在这里执行（见 addTombstone）。
 *
 * 三端同步的完整顺序（顺序本身是设计的一部分）：
 *   1. 推本地删除 → 云端删记录 + 写云端墓碑（让其他端知道）
 *   2. 拉云端删除 → 清掉本地对应记录（否则第 3 步会把它推回来）
 *   3. 推剩下的记录
 *
 * @returns {{ok:boolean, synced:number, deleted?:number,
 *            pulledRemoved?:number, pulledRevived?:number, reason?:string}}
 */
export async function syncAll(jobs, onProgress) {
  let s = await getSyncSettings();
  if (!isSyncConfigured(s)) return { ok: false, synced: 0, reason: "还没配置 Supabase URL 和 Key。" };
  if (!s.refreshToken) return { ok: false, synced: 0, reason: "还没登录——在设置页填邮箱密码登录。" };

  try {
    s = await refreshIfNeeded(s);
  } catch {
    return { ok: false, synced: 0, reason: "登录已过期，请重新登录。" };
  }

  await ensureHostPermission(s.supabaseUrl);

  /* 先执行删除，再推送。顺序有意义：如果先推送后删除，
     刚刚被 upsert 上去的记录可能又被墓碑删掉（同一个 key 既在 jobs 里
     又在墓碑里的情况——比如删完又重新采集了同一个岗位）。
     先删后推，最终状态就是"本地现在有什么，云端就是什么"。 */
  const tombs = await getTombstones();
  let deleted = 0;
  if (tombs.length) {
    const done = await flushTombstones(s, tombs);
    deleted = done.length;
    const left = tombs.filter((k) => !done.includes(k));
    await chrome.storage.local.set({ deletedKeys: left });
  }

  /* 再拉云端删除：工作台删掉的记录本地还有，不清掉的话下面的推送
     会把它重新 upsert 回云端——记录复活。这一步必须在推送之前。 */
  const pulled = await pullDeletions(s);
  if (pulled.removed) {
    // 本地记录被清掉了，jobs 这个入参已经过期，重新读一遍
    const fresh = await chrome.storage.local.get({ jds: [] });
    jobs = fresh.jds;
  }

  let synced = 0;
  for (const job of jobs) {
    const jdResp = await authedFetch(s, restUrl(s.supabaseUrl, "/career_jds?on_conflict=user_id,job_key"), {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        job_key: job.key,
        title: job.title,
        company: job.company,
        salary: job.salary,
        // 结构化薪资。解析不出来时全部推 null——数据库那边有 check 约束
        // （1000~2000000、min<=max、months 12~24），推一个荒唐值会整条写入失败，
        // 所以这里必须诚实地给 null，不能拿原文里的任意数字凑。
        salary_min: job.salaryParsed?.min ?? null,
        salary_max: job.salaryParsed?.max ?? null,
        salary_months: job.salaryParsed?.months ?? null,
        salary_period: job.salaryParsed?.period ?? null,
        salary_source: job.salarySource || null,
        tagline: job.tagline,
        url: job.url,
        site: job.site,
        intent: job.intent,
        status: job.status,
        fail_reason: job.failReason,
        body: job.body,
        page_text: job.pageText,
        collected_at: job.ts,
      }),
    });
    if (!jdResp.ok) {
      const t = await jdResp.text().catch(() => "");
      return { ok: false, synced, reason: `同步「${job.title}」失败：${t.slice(0, 160)}` };
    }

    // 状态历史逐条 upsert 不好做幂等键（同一岗位可能多次经过同一状态），
    // 改成"先删本岗位的历史再整批插入"——这条记录的历史以本地为准，
    // 因为扩展这边有完整的 pushStatus 时间戳，不会有云端独有的历史条目。
    if (job.statusHistory && job.statusHistory.length) {
      await authedFetch(s, restUrl(s.supabaseUrl, `/career_status_history?job_key=eq.${encodeURIComponent(job.key)}`), {
        method: "DELETE",
      });
      const histResp = await authedFetch(s, restUrl(s.supabaseUrl, "/career_status_history"), {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(
          job.statusHistory.map((h) => ({ job_key: job.key, status: h.status, at: h.at }))
        ),
      });
      if (!histResp.ok) {
        const t = await histResp.text().catch(() => "");
        return { ok: false, synced, reason: `同步「${job.title}」的状态历史失败：${t.slice(0, 160)}` };
      }
    }

    synced += 1;
    onProgress?.(synced, jobs.length);
  }

  // 记下同步时刻。这是"还有多少没推上去"唯一可信的基准——
  // 没有它，界面只能说"点一下同步"，说不出到底该不该点。
  await chrome.storage.local.set({ lastSyncAt: new Date().toISOString() });

  return { ok: true, synced, deleted, pulledRemoved: pulled.removed, pulledRevived: pulled.revived };
}

/** 上次同步成功的时刻（ISO，没同步过就是 ""）。 */
export async function getLastSync() {
  const { lastSyncAt = "" } = await chrome.storage.local.get({ lastSyncAt: "" });
  return lastSyncAt;
}

/**
 * 还有多少东西没推到云端。
 *
 * ⚠️ 这个数字是**下限，不是总数**，界面上的措辞必须跟着它：
 *   - 新采集的能算准：记录的 ts 就是采集时刻，晚于上次同步就一定没推过。
 *   - 待删的能算准：墓碑本身就是"待推的删除"。
 *   - **改动算不准**：补薪资、改意向都不更新 ts，所以改过但没重推的记录
 *     数不出来。所以文案只说「N 条新采集未推」，不敢说「N 条待同步」——
 *     后者是个我兑现不了的承诺。
 */
export async function countPending(jobs) {
  const last = await getLastSync();
  const tombs = await getTombstones();
  const fresh = last ? (jobs || []).filter((j) => j.ts && j.ts > last).length : (jobs || []).length;
  return { fresh, deletes: tombs.length, neverSynced: !last };
}

export function explainSyncError(msg) {
  const m = String(msg || "");
  if (m === "NO_CONFIG") return "还没配置 Supabase URL 和 anon key。";
  if (m.startsWith("LOGIN_FAILED:400")) return "邮箱或密码不对。";
  if (m.startsWith("LOGIN_FAILED:")) return "登录失败：" + m.slice(13, 160);
  if (m === "NOT_LOGGED_IN") return "还没登录。";
  if (m === "REFRESH_FAILED") return "登录状态刷新失败，请重新登录。";
  return m.slice(0, 200);
}
