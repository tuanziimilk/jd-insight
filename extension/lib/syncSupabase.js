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

/**
 * 把一批本地 JD（含 statusHistory）同步进 career_jds + career_status_history。
 *
 * 只做 upsert，不做删除——本地删记录不会同步删云端，避免"网络抖动导致的
 * 空列表"被错误当成"用户真的清空了"而级联删掉云端数据（不可逆的损失要避免）。
 *
 * @returns {{ok:boolean, synced:number, reason?:string}}
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

  return { ok: true, synced };
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
