(() => {
  const AVATAR_COLORS = [
    "#f59e0b", "#ef4444", "#10b981", "#3b82f6", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
  ];
  const WHEEL_COLORS = ["#c7d6ea", "#f6d7a7", "#cfe8d5", "#f3c9c9", "#ddd3f0", "#bfe3e6"];
  const SETTINGS_KEY = "bionexus-lunch-settings";
  const LOCAL_STORE_KEY = "bionexus-lunch-local-store";
  const MAX_WHEEL = 12;
  const KAKAO_KEY_STORAGE = "bionexus-lunch-kakao-key";
  const WALK_METERS_PER_MIN = 67;
  const LOCATE_RADIUS = 3000; // 직접 추가한 가게를 카카오맵에서 찾을 범위(m)

  const WEATHERS = {
    normal: { label: "☀️ 보통" },
    rain:   { label: "🌧 비·눈", boost: "국물", reason: "🌧 비 오는 날 국물" },
    cold:   { label: "🥶 추움",  boost: "국물", reason: "🥶 추운 날 국물" },
    hot:    { label: "🥵 더움",  boost: "시원", reason: "🥵 더운 날 시원한 것" },
  };
  const MOODS = {
    any:    { label: "상관없음" },
    light:  { label: "🥗 가볍게",   tag: "가벼움" },
    hearty: { label: "🍖 든든하게", tag: "든든" },
    quick:  { label: "⚡ 빨리",     tag: "빠름" },
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pad = (n) => String(n).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayKey = () => dateKey(new Date());
  function daysAgo(key) {
    const [y, m, d] = key.split("-").map(Number);
    const now = new Date();
    return Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(y, m - 1, d)) / 86400000);
  }

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch (_) { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  const settings = readJson(SETTINGS_KEY, {});
  const state = {
    office: "gangnam",
    hideDisliked: !!settings.hideDisliked,
    mood: settings.moodDate === todayKey() && MOODS[settings.mood] ? settings.mood : "any",
    lastClicked: null,
    query: "",
    openShops: new Set(), // 가게 목록을 펼친 메뉴 이름
    confirmDelete: null,  // 삭제 확인 대기 중인 가게 id
    autoWeather: {},      // 사무실 → undefined: 불러오는 중, "failed", 또는 { kind, temp, rainy }
    kakaoResults: {},     // "사무실|메뉴" → { status, keyword, items }
    roulette: null,
  };

  function saveSettings() {
    writeJson(SETTINGS_KEY, { hideDisliked: state.hideDisliked, mood: state.mood, moodDate: todayKey() });
  }

  // =================================================================
  // 저장소: claude.ai 링크에서는 모두가 공유하는 db, 그 외에는 이 브라우저
  // =================================================================
  const store = { mode: "connecting", backend: null, people: {}, prefs: {}, days: {}, restaurants: {}, checkins: {}, requests: {}, ratings: {}, secrets: {} };
  // secrets: Supabase가 없을 때만 쓰는 로그인 확인용 (Supabase에서는 서버의 lunch_secrets 표가 대신함)
  const COLLECTIONS = ["people", "prefs", "days", "restaurants", "checkins", "requests", "ratings", "secrets"];
  const SUPABASE_TABLE = "lunch_docs";
  const SUPABASE_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js";
  let db = null; // claude.ai 링크의 공유 저장소
  let sb = null; // Supabase 클라이언트

  const supabaseConfigured = () =>
    typeof SUPABASE_URL === "string" && SUPABASE_URL.trim() !== "" &&
    typeof SUPABASE_ANON_KEY === "string" && SUPABASE_ANON_KEY.trim() !== "";

  function loadScript(src, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      s.src = src;
      s.onload = () => { clearTimeout(timer); resolve(); };
      s.onerror = () => { clearTimeout(timer); reject(new Error("load")); };
      document.head.appendChild(s);
    });
  }

  async function refreshFromSupabase(client) {
    const { data, error } = await client.from(SUPABASE_TABLE).select("collection,id,data").limit(10000);
    if (error) throw error;
    const next = Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
    (data || []).forEach((row) => {
      if (next[row.collection] && row.data && typeof row.data === "object") next[row.collection][row.id] = row.data;
    });
    COLLECTIONS.forEach((c) => { store[c] = next[c]; });
  }

  async function connectSupabase() {
    if (!supabaseConfigured()) return false;
    try {
      if (!(window.supabase && window.supabase.createClient)) await loadScript(SUPABASE_SDK_URL);
      // "https://xxx.supabase.co/rest/v1/" 처럼 붙여 넣어도 앞부분만 사용
      const url = SUPABASE_URL.trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
      const client = window.supabase.createClient(url, SUPABASE_ANON_KEY.trim(), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      await refreshFromSupabase(client);
      sb = client;
      store.backend = "supabase";
      store.mode = "shared";
      client.channel("lunch-docs")
        .on("postgres_changes", { event: "*", schema: "public", table: SUPABASE_TABLE }, (payload) => {
          const removed = payload.eventType === "DELETE";
          const row = removed ? payload.old : payload.new;
          if (!row || !COLLECTIONS.includes(row.collection) || typeof row.id !== "string") return;
          if (removed) delete store[row.collection][row.id];
          else if (row.data && typeof row.data === "object") store[row.collection][row.id] = row.data;
          render();
        })
        .subscribe();
      // 실시간 연결이 끊겼던 동안의 변경은 화면으로 돌아올 때 다시 읽어서 맞춤
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshFromSupabase(sb).then(render).catch(() => {});
      });
      render();
      return true;
    } catch (e) {
      console.warn("Supabase 연결 실패", e);
      store.supabaseError = true;
      return false;
    }
  }

  function useLocalStore() {
    const saved = readJson(LOCAL_STORE_KEY, {});
    COLLECTIONS.forEach((c) => { store[c] = saved[c] && typeof saved[c] === "object" ? saved[c] : {}; });
    store.mode = "local";
    store.backend = "local";
    render();
  }

  async function connectStore() {
    if (await connectSupabase()) return;
    try {
      db = window.claude && typeof window.claude.use === "function" ? await window.claude.use("db") : null;
    } catch (_) {
      db = null;
    }
    if (!db) return useLocalStore();

    store.backend = "claude";
    store.mode = "shared";
    COLLECTIONS.forEach((name) => {
      db.collection(name).onSnapshot((snap) => {
        const map = {};
        snap.docs.forEach((d) => { if (d.exists) map[d.id] = d.data(); });
        store[name] = map;
        render();
      }, (e) => {
        console.warn(`${name} 구독 오류`, e);
        if (e && e.code === "revoked") useLocalStore();
      });
    });
    render();
  }

  // data 가 null 이면 삭제
  async function write(collection, id, data) {
    if (store.mode === "connecting") {
      toast("아직 연결 중이에요. 잠시 후 다시 눌러 주세요.");
      return false;
    }
    if (store.mode === "local") {
      if (data) store[collection][id] = data; else delete store[collection][id];
      writeJson(LOCAL_STORE_KEY, Object.fromEntries(COLLECTIONS.map((c) => [c, store[c]])));
      render();
      return true;
    }
    if (store.backend === "supabase") {
      const { error } = data
        ? await sb.from(SUPABASE_TABLE).upsert({ collection, id, data, updated_at: new Date().toISOString() })
        : await sb.from(SUPABASE_TABLE).delete().match({ collection, id });
      if (error) {
        console.warn("Supabase 저장 실패", error);
        const outdated = /23514|42501|check constraint|row-level security/i.test(`${error.code} ${error.message}`);
        toast(outdated
          ? "서버 설정이 최신이 아니에요. 관리자가 Supabase에서 supabase.sql을 다시 실행해야 해요."
          : "저장하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.");
        return false;
      }
      // 실시간 알림이 늦게 와도 내 화면은 바로 반영
      if (data) store[collection][id] = data; else delete store[collection][id];
      render();
      return true;
    }
    try {
      const ref = db.collection(collection).doc(id);
      if (data) await ref.set(data); else await ref.delete();
      return true;
    } catch (e) {
      const code = e && e.code;
      toast(code === "invalid_argument"
        ? "저장할 권한이 없어요. 공유 설정에서 참여자(Contributor) 이상 권한을 받아야 해요."
        : code === "quota_exceeded"
          ? "저장 공간이 가득 찼어요. 안 쓰는 가게를 지워 주세요."
          : "저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
      return false;
    }
  }

  const strList = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : null;

  // 각자 로그인해서 저장한 취향
  function prefsOf(p) {
    const saved = p && store.prefs[p.id];
    return {
      likes: (saved && strList(saved.likes)) || [],
      dislikes: (saved && strList(saved.dislikes)) || [],
      allergies: ((saved && strList(saved.allergies)) || []).filter((a) => ALLERGENS.includes(a)),
    };
  }

  // =================================================================
  // 로그인: 이름 + "제일 좋아하는 음식"(비밀번호)
  // =================================================================
  const SESSION_KEY = "bionexus-lunch-session";
  const normSecret = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
  let session = readJson(SESSION_KEY, null); // { id, secret }
  if (!session || typeof session.id !== "string" || typeof session.secret !== "string") session = null;

  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Supabase 함수 호출 오류 → 화면에 보여줄 결과 코드
  // 함수를 못 찾음 = supabase.sql 을 최신으로 다시 실행하지 않음
  function rpcFailure(error) {
    console.warn("Supabase 함수 호출 실패", error);
    const text = `${error && error.code} ${error && error.message}`;
    return /PGRST202|42883|Could not find the function|does not exist/i.test(text) ? "outdated" : "error";
  }

  // 결과: "new" | "ok" | "wrong" | "locked" | "invalid" | "error" | "outdated"
  async function checkSecret(id, secret) {
    if (store.backend === "supabase") {
      const { data, error } = await sb.rpc("lunch_check_secret", { p_person: id, p_secret: secret });
      return error ? rpcFailure(error) : data;
    }
    const saved = store.secrets[id];
    if (!saved || typeof saved.hash !== "string") return "new";
    return saved.hash === await sha256(`${id}:${secret}`) ? "ok" : "wrong";
  }

  // 비밀번호가 맞으면 취향(+ 주 사무실, 알레르기) 저장.
  // register = true 는 관리자가 비밀번호를 초기화한 뒤 새로 정할 때만
  // allergies = null 이면 예전 알레르기를 그대로 둠
  async function savePrefsAuthed(id, secret, likes, dislikes, register = false, office = null, allergies = null) {
    const keep = prefsOf(personById(id)).allergies;
    if (store.backend === "supabase") {
      const args = { p_person: id, p_secret: secret, p_likes: likes, p_dislikes: dislikes, p_register: register, p_office: office };
      if (allergies) args.p_allergies = allergies;
      const { data, error } = await sb.rpc("lunch_save_prefs", args);
      if (error) return rpcFailure(error);
      if (data === "ok") {
        store.prefs[id] = { likes, dislikes, allergies: allergies || keep };
        if (office && store.people[id]) store.people[id] = { ...store.people[id], office };
        render();
      }
      return data;
    }
    if (!store.people[id]) return "invalid";
    const v = await checkSecret(id, secret);
    if (v === "new" && !register) return "new";
    if (v === "new" && !(await write("secrets", id, { hash: await sha256(`${id}:${secret}`) }))) return "error";
    if (v !== "new" && v !== "ok") return v;
    if (office && store.people[id].office !== office && !(await write("people", id, { ...store.people[id], office }))) return "error";
    return (await write("prefs", id, { likes, dislikes, allergies: allergies || keep })) ? "ok" : "error";
  }

  // 가입: 성공하면 새 id, 아니면 "taken" | "invalid" | "error"
  async function registerPerson(name, office, secret) {
    if (store.backend === "supabase") {
      const { data, error } = await sb.rpc("lunch_register", { p_name: name, p_office: office, p_secret: secret });
      if (error) return rpcFailure(error);
      if (/^u[0-9a-f]{12}$/.test(data)) {
        store.people[data] = { name, office };
        store.prefs[data] = { likes: [], dislikes: [], allergies: [] };
      }
      return data;
    }
    if (findPersonByName(name)) return "taken";
    const id = "u" + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const ok = await write("people", id, { name, office })
      && await write("secrets", id, { hash: await sha256(`${id}:${secret}`) })
      && await write("prefs", id, { likes: [], dislikes: [], allergies: [] });
    return ok ? id : "error";
  }

  const AUTH_MESSAGES = {
    wrong: "좋아하는 음식이 맞지 않아요. 띄어쓰기는 상관없어요.",
    locked: "5번 틀려서 10분 동안 잠겼어요. 잠시 후 다시 해 주세요.",
    invalid: "입력한 내용을 확인해 주세요. (이름은 20자, 음식 이름은 50자까지)",
    taken: "같은 이름으로 이미 가입한 분이 있어요. 성이나 별명을 붙여 주세요. (예: 박재형)",
    error: "연결에 실패했어요. 잠시 후 다시 해 주세요.",
    outdated: "서버 설정이 최신이 아니에요. 관리자가 Supabase에서 supabase.sql을 다시 실행해야 해요.",
  };

  // 가입한 사람들 (사무실 간 이동이 잦아서 사람은 사무실과 상관없이 전체에서 고름)
  const allPeople = () => Object.entries(store.people)
    .filter(([, d]) => d && typeof d.name === "string" && d.name.trim())
    .map(([id, d]) => ({ id, name: d.name.trim(), office: OFFICES[d.office] ? d.office : null }))
    .sort((x, y) => x.name.localeCompare(y.name, "ko"));
  const officePeople = () => allPeople().filter((p) => p.office === state.office);
  const personById = (id) => allPeople().find((p) => p.id === id);
  const findPersonByName = (name) => allPeople().find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  const officeShort = (key) => (OFFICES[key] ? OFFICES[key].label.replace("편", "") : "");
  const colorOf = (id) => AVATAR_COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR_COLORS.length];
  // 오늘의 명단 = 출석 체크(checkins). 모두가 같은 명단을 봄
  // 사람마다 하루 한 줄(ci_날짜_사람id)이라, 다른 사무실에서 다시 체크인하면 그쪽으로 옮겨짐
  const checkinId = (personId) => `ci_${todayKey()}_${personId}`;
  const todaysCheckins = (office = state.office) => Object.values(store.checkins)
    .filter((c) => c && c.date === todayKey() && c.office === office && typeof c.person === "string");
  const selectedIds = () => new Set(todaysCheckins().map((c) => c.person));
  const selectedPeople = () => { const ids = selectedIds(); return allPeople().filter((p) => ids.has(p.id)); };
  const myCheckin = () => session && store.checkins[checkinId(session.id)];

  function checkIn(personId) {
    return write("checkins", checkinId(personId), {
      office: state.office, date: todayKey(), person: personId, by: session ? session.id : null, at: new Date().toISOString(),
    });
  }
  const checkOut = (personId) => write("checkins", checkinId(personId), null);
  const dayId = (date) => `${state.office}_${date}`;
  const todayDoc = () => store.days[dayId(todayKey())] || null;

  async function updateToday(patch) {
    const next = { office: state.office, date: todayKey(), ...(todayDoc() || {}), ...patch };
    Object.keys(next).forEach((k) => { if (next[k] == null) delete next[k]; });
    return write("days", dayId(todayKey()), next);
  }

  // 최근 RECENT_DAYS 일 안에 먹은 메뉴 → 며칠 전인지
  function recentEaten() {
    const map = new Map();
    Object.values(store.days).forEach((d) => {
      if (!d || d.office !== state.office || typeof d.menu !== "string" || typeof d.date !== "string") return;
      const ago = daysAgo(d.date);
      if (ago >= 1 && ago <= RECENT_DAYS && (!map.has(d.menu) || map.get(d.menu) > ago)) map.set(d.menu, ago);
    });
    return map;
  }

  // 가게 별점: 사람마다 가게 하나에 한 줄(rt_가게키_사람id)
  // 가게키 = 카카오맵 장소 번호(k123…) 또는 직접 추가한 가게의 id
  const validStars = (v) => typeof v === "number" && v >= 0.5 && v <= 5 && Math.round(v * 2) === v * 2;
  const shopKey = (shop) => {
    const url = shop && (shop.kakaoUrl || shop.url);
    if (typeof url === "string" && /^https?:\/\/place\.map\.kakao\.com\/\d+$/.test(url)) return "k" + url.split("/").pop();
    return shop && shop.id ? String(shop.id) : null;
  };
  const ratingId = (key, personId) => `rt_${key}_${personId}`;

  // 가게별 별점 집계: 가게키 → { sum, count, name, office }
  function shopRatings() {
    const map = new Map();
    Object.values(store.ratings).forEach((r) => {
      if (!r || typeof r.shop !== "string" || !validStars(r.stars)) return;
      const s = map.get(r.shop) || { sum: 0, count: 0, name: "", office: "" };
      s.sum += r.stars;
      s.count += 1;
      if (typeof r.name === "string" && r.name) s.name = r.name;
      if (OFFICES[r.office]) s.office = r.office;
      map.set(r.shop, s);
    });
    return map;
  }

  const avgOf = (s) => (s && s.count ? s.sum / s.count : 0);
  const ratingText = (s) => (s && s.count ? `★${avgOf(s).toFixed(1)} (${s.count}명)` : "");

  // 가게 하나의 별점 줄: 내 별점(로그인 시 누를 수 있음) + 우리 평균
  function shopStarsHtml(key, name, ratings) {
    if (!key) return "";
    const s = ratings.get(key);
    const mine = session && store.ratings[ratingId(key, session.id)];
    const my = mine && validStars(mine.stars) ? mine.stars : 0;
    const avg = `<span class="star-avg">${s ? `우리 평균 ★${avgOf(s).toFixed(1)} (${s.count}명)` : "아직 별점 없음"}</span>`;
    const picker = session
      ? `<span class="stars small" data-shop-key="${esc(key)}" data-shop-name="${esc(name)}" role="group" aria-label="${esc(name)} 별점, 0.5점 단위">${starsHtml(my, true)}</span>
         <span class="star-value">${my ? my.toFixed(1) : ""}</span>`
      : `<button type="button" class="link-button" data-star-login>로그인하고 별점 주기</button>`;
    return `<span class="shop-stars">${picker}${avg}</span>`;
  }

  // 0.5점 단위 별 5개 (각 별의 왼쪽 반 = .5, 오른쪽 반 = 정수)
  function starsHtml(value, interactive) {
    return [1, 2, 3, 4, 5].map((n) => {
      const cls = value >= n ? "s-full" : value >= n - 0.5 ? "s-half" : "s-empty";
      const halves = interactive
        ? `<button type="button" class="star-half left" data-stars="${n - 0.5}" aria-label="${n - 0.5}점"></button><button type="button" class="star-half right" data-stars="${n}" aria-label="${n}점"></button>`
        : "";
      return `<span class="star ${cls}" aria-hidden="${interactive ? "false" : "true"}">${halves}</span>`;
    }).join("");
  }

  // =================================================================
  // 날씨
  // =================================================================
  async function loadWeather(officeKey) {
    if (state.autoWeather[officeKey] !== undefined) return;
    state.autoWeather[officeKey] = null;
    const loc = OFFICES[officeKey].location;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
        "&current=temperature_2m,precipitation,weather_code&timezone=Asia%2FSeoul";
      const res = await fetch(url, { signal: ctrl.signal });
      const c = (await res.json()).current;
      const code = c.weather_code;
      const rainy = c.precipitation > 0 || (code >= 51 && code <= 67) || (code >= 71 && code <= 86) || code >= 95;
      const temp = Math.round(c.temperature_2m);
      const kind = rainy ? "rain" : temp <= 3 ? "cold" : temp >= 28 ? "hot" : "normal";
      state.autoWeather[officeKey] = { kind, temp, rainy };
    } catch (_) {
      state.autoWeather[officeKey] = "failed";
    } finally {
      clearTimeout(timer);
    }
    render();
  }

  function currentWeather() {
    const day = todayDoc();
    if (day && WEATHERS[day.weather]) return { kind: day.weather, source: "manual" };
    const auto = state.autoWeather[state.office];
    if (auto && auto !== "failed") return { kind: auto.kind, source: "auto" };
    return { kind: "normal", source: "none" };
  }

  // =================================================================
  // 점수
  // =================================================================
  function scoreMenus() {
    const people = selectedPeople();
    const weather = WEATHERS[currentWeather().kind];
    const mood = MOODS[state.mood];
    const recent = recentEaten();

    return MENUS.map((menu, index) => {
      const ups = [];
      const downs = [];
      const allergic = [];
      const extras = [];
      for (const p of people) {
        const { likes, dislikes, allergies } = prefsOf(p);
        const liked = likes.filter((t) => matchesMenu(menu, t));
        const disliked = dislikes.filter((t) => matchesMenu(menu, t));
        const risky = allergies.filter((a) => (menu.allergens || []).includes(a));
        if (liked.length) ups.push({ who: p.name, tags: liked });
        if (disliked.length) downs.push({ who: p.name, tags: disliked });
        if (risky.length) allergic.push({ who: p.name, tags: risky });
      }
      if (weather.boost && menu.tags.includes(weather.boost)) extras.push({ text: weather.reason, delta: 1 });
      if (mood.tag && menu.tags.includes(mood.tag)) extras.push({ text: mood.label, delta: 1 });
      if (recent.has(menu.name)) extras.push({ text: `🕒 ${recent.get(menu.name)}일 전에 먹음`, delta: -1 });
      // 좋아하는 사람 1명당 +1, 싫어하는 사람 1명당 -1, 날씨·기분 +1, 최근 먹음 -1
      const score = ups.length - downs.length + extras.reduce((s, x) => s + x.delta, 0);
      return { ...menu, index, score, ups, downs, allergic, extras };
    }).sort((a, b) => (a.allergic.length > 0) - (b.allergic.length > 0) || b.score - a.score || a.index - b.index);
    // 알레르기 재료가 들어갈 수 있는 메뉴는 점수와 상관없이 맨 아래
  }

  // 숨기기 모드면 한 명이라도 싫어하거나 알레르기가 있는 메뉴 제외
  function visibleMenus() {
    const ranked = scoreMenus();
    return state.hideDisliked ? ranked.filter((m) => m.downs.length === 0 && m.allergic.length === 0) : ranked;
  }

  // =================================================================
  // 화면
  // =================================================================
  // 얼굴 + 어깨가 보이는 사람 아이콘
  function avatarSvg(color) {
    return `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="31" fill="${color}" fill-opacity=".15" />
        <path d="M8 60c0-13 10.7-21 24-21s24 8 24 21" fill="${color}" />
        <circle cx="32" cy="24" r="12" fill="#fde2c8" stroke="${color}" stroke-width="2" />
        <path d="M20 22c0-7 5.5-11 12-11s12 4 12 11c-3-3-7-4.5-12-4.5S23 19 20 22z" fill="#3f3f46" />
        <circle cx="27.5" cy="25" r="1.4" fill="#3f3f46" />
        <circle cx="36.5" cy="25" r="1.4" fill="#3f3f46" />
        <path d="M28 30c2.4 2 5.6 2 8 0" stroke="#3f3f46" stroke-width="1.6" fill="none" stroke-linecap="round" />
      </svg>`;
  }

  // 특별 아이콘: 정장 + 넥타이 + 선글라스 + 반짝이
  function specialAvatarSvg() {
    return `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id="special-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#fcd34d" />
            <stop offset="1" stop-color="#b45309" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="30" fill="#1e293b" stroke="url(#special-ring)" stroke-width="2.5" />
        <path d="M8 60c0-13 10.7-21 24-21s24 8 24 21" fill="#0f172a" />
        <path d="M25 39.5 32 50l7-10.5c-2.2-.6-4.5-.9-7-.9s-4.8.3-7 .9z" fill="#f8fafc" />
        <path d="M30.4 41h3.2l1 2.4-1.4 9.6h-2.4l-1.4-9.6z" fill="#dc2626" />
        <path d="M22 40.5 32 52l-6 1-6-11zM42 40.5 32 52l6 1 6-11z" fill="#334155" />
        <circle cx="32" cy="25" r="11.5" fill="#fde2c8" />
        <path d="M20 24c-1-9 5-14 12.5-14 6 0 11.5 3 11.5 9.5 0 2-.4 3.5-1 4.5-.6-4-3-6-6-6.5-4.5-.7-9 .5-12 3-2 1.5-3.6 2.8-5 3.5z" fill="#111827" />
        <path d="M24 13c4-4 12-4.5 16-1-5-1-10 0-13.5 3z" fill="#374151" />
        <rect x="21.5" y="22.5" width="9" height="5.5" rx="2.2" fill="#111827" />
        <rect x="33.5" y="22.5" width="9" height="5.5" rx="2.2" fill="#111827" />
        <path d="M30.5 24.2h3" stroke="#111827" stroke-width="1.4" />
        <path d="M23.5 24l2.5-.6M35.5 24l2.5-.6" stroke="#94a3b8" stroke-width="1" stroke-linecap="round" />
        <path d="M27.5 31.5c2.8 2 6.2 2 9 0" stroke="#3f3f46" stroke-width="1.6" fill="none" stroke-linecap="round" />
        <path d="M52 12l1.2 3 3 1.2-3 1.2-1.2 3-1.2-3-3-1.2 3-1.2zM11 18l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" fill="#fcd34d" />
      </svg>`;
  }


  function renderTabs() {
    $("tabs").innerHTML = Object.entries(OFFICES).map(([key, o]) =>
      `<button class="tab" role="tab" data-office="${key}" aria-selected="${key === state.office}">${o.label}</button>`
    ).join("");
  }

  // 공유 저장소가 생기기 전에 이 브라우저에 저장해 둔 기록 → 공유 저장소로 옮기기
  function localLeftovers() {
    if (store.backend !== "supabase") return [];
    const saved = readJson(LOCAL_STORE_KEY, {});
    const rows = [];
    // 취향은 로그인해야만 바뀌므로 옮기지 않음
    ["days", "restaurants"].forEach((c) => {
      Object.entries(saved[c] && typeof saved[c] === "object" ? saved[c] : {}).forEach(([id, data]) => {
        if (data && typeof data === "object" && !store[c][id]) rows.push({ collection: c, id, data });
      });
    });
    return rows;
  }

  function renderMigrate() {
    const box = $("migrate");
    const rows = localLeftovers();
    box.hidden = rows.length === 0;
    if (rows.length) {
      box.innerHTML = `이 브라우저에만 저장된 기록이 ${rows.length}개 있어요.
        <button class="primary small" data-migrate>모두와 공유하기</button>
        <button class="ghost small" data-migrate-skip>버리기</button>`;
    }
  }

  async function migrateLocal() {
    const rows = localLeftovers().map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    if (!rows.length) return;
    const { error } = await sb.from(SUPABASE_TABLE).upsert(rows, { onConflict: "collection,id", ignoreDuplicates: true });
    if (error) return toast("옮기지 못했어요. 잠시 후 다시 시도해 주세요.");
    rows.forEach((r) => { if (!store[r.collection][r.id]) store[r.collection][r.id] = r.data; });
    writeJson(LOCAL_STORE_KEY, {});
    toast(`기록 ${rows.length}개를 모두와 공유했어요.`);
    render();
  }

  function renderSync() {
    const el = $("sync");
    el.dataset.mode = store.mode;
    el.textContent = store.mode === "shared" ? "● 모두와 실시간 공유 중"
      : store.mode === "local"
        ? (store.supabaseError ? "공유 저장소 연결 실패 · 이 브라우저에만 저장돼요" : "이 브라우저에만 저장돼요")
        : "연결 중…";
    renderMigrate();
  }

  function personCard(p) {
    return `
      <div class="person-wrap">
        <button class="person${p.special ? " special" : ""}" data-id="${p.id}" aria-pressed="true" title="${esc(p.name)}님 취향 보기">
          ${p.special ? specialAvatarSvg() : avatarSvg(colorOf(p.id))}
          <span class="name">${esc(p.name)}님</span>
          <span class="office-tag">${officeShort(p.office)}</span>
        </button>
        <button class="remove" data-remove="${p.id}" aria-label="${esc(p.name)}님 빼기">×</button>
      </div>`;
  }

  function renderCheckinButton() {
    const btn = $("checkin");
    const mine = myCheckin();
    const here = mine && mine.office === state.office;
    btn.classList.toggle("on", !!here);
    btn.textContent = !session ? "🙋 로그인하고 출석 체크"
      : here ? "✓ 출석함 (취소)"
      : mine ? `🙋 여기로 옮기기 (지금 ${officeShort(mine.office)})`
      : "🙋 나 오늘 여기서 먹어요";
  }

  function renderPeople() {
    renderCheckinButton();
    const people = selectedPeople();
    const ids = selectedIds();
    $("people").innerHTML = people.map(personCard).join("");
    $("people").hidden = people.length === 0;

    // 검색 결과
    const q = state.query.trim();
    const matches = q ? allPeople().filter((p) => p.name.includes(q)) : [];
    $("people-results").innerHTML = q
      ? (matches.length
        ? matches.map((p) => {
            const on = ids.has(p.id);
            return `<button class="chip tap ${on ? "active" : ""}" data-pick="${p.id}" aria-pressed="${on}">${on ? "✓ " : "+ "}${esc(p.name)}님 <small>${officeShort(p.office)}</small></button>`;
          }).join("")
        : `<p class="hint tight">'${esc(q)}'(으)로 찾은 사람이 없어요. 아직 가입 전이면 오른쪽 위 🔑 로그인에서 가입할 수 있어요.</p>`)
      : "";

    const where = officeShort(state.office);
    $("selection-summary").textContent = allPeople().length === 0
      ? "아직 가입한 사람이 없어요. 오른쪽 위 🔑 로그인 / 가입에서 이름과 좋아하는 음식으로 가입해 주세요."
      : people.length === 0
      ? `오늘 ${where}에서 먹는 사람이 아직 없어요. 각자 🙋 버튼을 누르거나 이름을 검색해서 추가하세요. 모두의 화면에 똑같이 보여요.`
      : `오늘 ${where}에서 ${people.length}명: ${people.map((p) => p.name + "님").join(", ")} · 모두의 화면에 같은 명단이 보여요`;
  }

  // 메뉴 이름 자체(예: 마라탕)도 좋아요/싫어요 대상
  const matchesMenu = (menu, tag) => menu.name === tag || menu.tags.includes(tag);
  const KNOWN_TAGS = new Set([...MENUS.map((m) => m.name), ...TAG_GROUPS.flatMap((g) => g.tags)]);

  const menusFor = (tags) => MENUS.filter((m) => tags.some((t) => matchesMenu(m, t))).map((m) => m.name);

  // 가장 최근에 누른 사람의 취향 카드 (+ 취향 수정)
  function renderFocus() {
    const box = $("focus");
    const p = personById(state.lastClicked);
    box.hidden = !p;
    if (!p) return;

    const on = selectedIds().has(p.id);
    const mine = session && session.id === p.id;
    const head = `
      <div class="focus-head">
        <strong>${esc(p.name)}님</strong>
        <span class="focus-state ${on ? "on" : ""}">${on ? "오늘 같이 먹음 ✓" : "빠짐"}</span>
        ${mine
          ? `<button class="ghost small" data-open-me>✏️ 내 취향 수정</button>`
          : `<button class="ghost small" data-login-as="${p.id}" title="본인만 수정할 수 있어요">🔑 본인이면 로그인</button>`}
      </div>`;

    const { likes, dislikes, allergies } = prefsOf(p);
    const chips = (tags, cls) => tags.map((t) => `<span class="chip ${cls}">#${esc(t)}</span>`).join("");
    const row = (title, tags, cls) => `
      <div class="focus-row">
        <div class="focus-label ${cls}">${title}</div>
        ${tags.length
          ? `<div class="chips">${chips(tags, cls)}</div><div class="focus-menus">→ ${esc(menusFor(tags).join(", "))}</div>`
          : `<div class="focus-empty">아직 등록된 정보가 없어요</div>`}
      </div>`;
    box.innerHTML = `${head}
      ${row("👍 좋아하는 음식", likes, "up")}
      ${row("👎 싫어하는 음식", dislikes, "down")}
      ${allergies.length ? `
      <div class="focus-row">
        <div class="focus-label allergy">🚫 알레르기</div>
        <div class="chips">${chips(allergies, "allergy")}</div>
        <div class="focus-menus">→ 주의할 메뉴: ${esc(MENUS.filter((m) => (m.allergens || []).some((a) => allergies.includes(a))).map((m) => m.name).join(", "))}</div>
      </div>` : ""}`;
  }

  // 로그인·가입 창 / 내 취향 수정 창
  // step: "login" → (처음이면) "signup" / (비밀번호 초기화됐으면) "reset" → "edit"
  const auth = { open: false, step: "login", name: "", pickId: "", pending: "", msg: "", busy: false, draft: null, office: "" };

  function renderMeButton() {
    const me = session && personById(session.id);
    $("me-button").textContent = me ? `👤 ${me.name}님 · 내 취향` : "🔑 로그인 / 가입";
  }

  function draftFrom(id) {
    const { likes, dislikes, allergies } = prefsOf(personById(id));
    return { likes: new Set(likes), dislikes: new Set(dislikes), allergies: new Set(allergies) };
  }

  const officeOptions = (selected) => Object.entries(OFFICES)
    .map(([key, o]) => `<option value="${key}" ${selected === key ? "selected" : ""}>${o.label.replace("편", "")}${o.place ? ` (${esc(o.place)})` : ""}</option>`).join("");

  const allergyChip = (a, on) =>
    `<button type="button" class="chip tap ${on ? "allergy" : ""}" data-allergy="${esc(a)}" aria-pressed="${on}">${on ? "🚫 " : ""}${esc(a)}</button>`;

  const SECRET_LABEL = `제일 좋아하는 음식 <span class="pw-tag">(비밀번호)</span>`;

  function renderMe() {
    renderMeButton();
    $("me-panel").hidden = !auth.open;
    if (!auth.open) return;
    const body = $("me-body");
    const msg = auth.msg ? `<p class="hint tight error" role="alert">${esc(auth.msg)}</p>` : "";
    const me = session && personById(session.id);

    if (auth.step === "edit" && me) {
      const d = auth.draft;
      const chip = (t, label) => {
        const cls = d.likes.has(t) ? "up" : d.dislikes.has(t) ? "down" : "";
        const mark = cls === "up" ? "👍 " : cls === "down" ? "👎 " : "";
        return `<button type="button" class="chip tap ${cls}" data-cycle="${esc(t)}" data-label="${esc(label || t)}" aria-pressed="${!!cls}">${mark}${esc(label || t)}</button>`;
      };
      // 예전에 고른 태그 중 지금 목록에 없는 것도 지울 수 있게 보여줌
      const old = [...d.likes, ...d.dislikes].filter((t) => !KNOWN_TAGS.has(t));
      const groups = [
        ...TAG_GROUPS.map((g) => ({ name: g.name, items: g.tags.map((t) => chip(t, (t === "고기" || t === "해산물") ? `${t} 전체` : t)) })),
        { name: "메뉴", items: MENUS.map((m) => chip(m.name, `${m.emoji} ${m.name}`)) },
        ...(old.length ? [{ name: "예전에 고른 것", items: old.map((t) => chip(t)) }] : []),
      ];
      const chips = groups.map((g) => `
        <div class="tag-group">
          <div class="tag-group-name">${g.name}</div>
          <div class="chips">${g.items.join("")}</div>
        </div>`).join("");
      body.innerHTML = `
        <h2 id="me-title">${esc(me.name)}님의 취향</h2>
        <label class="me-field">주 사무실
          <select id="me-office">${officeOptions(auth.office || me.office)}</select>
        </label>
        <div class="tag-group allergy-group">
          <div class="tag-group-name">🚫 알레르기</div>
          <p class="hint tight">있는 것만 눌러 주세요. 오늘 같이 먹을 때 그 재료가 들어갈 수 있는 메뉴는 맨 아래로 내려가고 ⚠️ 표시돼요. (같이 먹는 사람들에게 보여요)</p>
          <div class="chips">${ALLERGENS.map((a) => allergyChip(a, d.allergies.has(a))).join("")}</div>
        </div>
        <p class="hint tight">한 번 누르면 👍 좋아함, 두 번 누르면 👎 싫어함, 세 번 누르면 해제돼요. 언제든 다시 바꿀 수 있어요.</p>
        <div class="me-chips">${chips}</div>
        <button type="button" class="link-button request-link" data-request>찾는 메뉴가 없나요? 메뉴 추가 요청하기</button>
        ${msg}
        <div class="me-actions">
          <button type="button" class="primary" data-save-me ${auth.busy ? "disabled" : ""}>저장</button>
          <button type="button" class="ghost" data-close-me>닫기</button>
          <button type="button" class="link-button" data-logout>로그아웃</button>
        </div>`;
      return;
    }

    if (auth.step === "signup") {
      body.innerHTML = `
        <h2 id="me-title">처음 오셨네요, ${esc(auth.name)}님!</h2>
        <p class="hint tight">주로 일하는 사무실을 고르고, 방금 입력한 음식을 한 번 더 입력하면 가입이 끝나요. 이 음식이 앞으로 비밀번호가 돼요.</p>
        <form class="me-form" id="signup-form">
          <label class="me-field">주 사무실
            <select id="signup-office">${officeOptions(auth.office || state.office)}</select>
          </label>
          <label class="me-field"><span>${SECRET_LABEL} 한 번 더</span>
            <input id="confirm-secret" type="password" autocomplete="off" maxlength="50" required />
          </label>
          ${msg}
          <div class="me-actions">
            <button class="primary" type="submit" ${auth.busy ? "disabled" : ""}>가입하고 취향 고르기</button>
            <button type="button" class="ghost" data-back>다시 입력</button>
          </div>
        </form>`;
      return;
    }

    if (auth.step === "reset") {
      body.innerHTML = `
        <h2 id="me-title">${esc(auth.name)}님, 비밀번호를 새로 정해요</h2>
        <p class="hint tight">관리자가 비밀번호를 초기화했어요. 방금 입력한 음식을 한 번 더 입력하면 새 비밀번호가 돼요.</p>
        <form class="me-form" id="reset-form">
          <label class="me-field"><span>${SECRET_LABEL} 한 번 더</span>
            <input id="confirm-secret" type="password" autocomplete="off" maxlength="50" required />
          </label>
          ${msg}
          <div class="me-actions">
            <button class="primary" type="submit" ${auth.busy ? "disabled" : ""}>새로 정하기</button>
            <button type="button" class="ghost" data-back>다시 입력</button>
          </div>
        </form>`;
      return;
    }

    body.innerHTML = `
      <h2 id="me-title">로그인 / 가입</h2>
      <p class="hint tight">이름과 <b>제일 좋아하는 음식</b>을 입력하세요. 처음이면 바로 가입되고, 이 음식이 비밀번호가 돼요.
        남들이 맞히기 어려운 음식으로 정해 주세요. (예: 어머니표 김치찌개)</p>
      <form class="me-form" id="login-form">
        <label class="me-field">이름
          <input id="login-name" maxlength="20" autocomplete="off" placeholder="예: 박재형" value="${esc(auth.name)}" required />
        </label>
        <label class="me-field"><span>${SECRET_LABEL}</span>
          <input id="login-secret" type="password" autocomplete="off" maxlength="50" placeholder="예: 어머니표 김치찌개" required />
        </label>
        ${msg}
        <div class="me-actions">
          <button class="primary" type="submit" ${auth.busy ? "disabled" : ""}>다음</button>
          <button type="button" class="ghost" data-close-me>닫기</button>
        </div>
      </form>`;
  }

  function openMe(pickId) {
    auth.open = true;
    auth.msg = "";
    const me = session && personById(session.id);
    if (me && (!pickId || pickId === session.id)) {
      auth.step = "edit";
      auth.office = me.office || "";
      auth.draft = draftFrom(session.id);
    } else {
      auth.step = "login";
      const pick = pickId && personById(pickId);
      if (pick) auth.name = pick.name;
    }
    renderMe();
    const first = $("me-body").querySelector(auth.step === "login" && auth.name ? "#login-secret" : "select, input, button");
    if (first) first.focus();
  }

  function closeMe() {
    auth.open = false;
    auth.pending = "";
    renderMe();
    $("me-button").focus();
  }

  function startSession(id, secret, isNew = false) {
    session = { id, secret };
    writeJson(SESSION_KEY, session);
    // 가입하자마자, 또는 출석 버튼을 눌러 로그인한 경우 오늘 명단에 바로 넣음
    if (isNew || auth.afterLogin === "checkin") checkIn(id);
    auth.afterLogin = null;
    const me = personById(id);
    auth.step = "edit";
    auth.office = (me && me.office) || "";
    auth.draft = draftFrom(id);
    auth.msg = "";
    auth.pending = "";
  }

  // 오늘 간 가게에 별점 주기
  function todayShopStars(day) {
    const shop = day.shop && shopsOf(day.menu).find((s) => s.name === day.shop);
    if (!shop) {
      return shopsOf(day.menu).length ? `<span class="today-field hint">어디서 먹었는지 고르면 그 가게에 ⭐ 별점을 줄 수 있어요</span>` : "";
    }
    return `<span class="today-field">${esc(shop.name)} 별점 ${shopStarsHtml(shopKey(shop), shop.name, shopRatings())}</span>`;
  }

  function renderConditions() {
    const w = currentWeather();
    const day = todayDoc();
    $("weather-chips").innerHTML = Object.entries(WEATHERS).map(([k, v]) =>
      `<button class="chip tap ${w.kind === k ? "active" : ""}" data-weather="${k}" aria-pressed="${w.kind === k}">${v.label}</button>`
    ).join("");

    const auto = state.autoWeather[state.office];
    const area = OFFICES[state.office].area || OFFICES[state.office].label;
    let note;
    if (w.source === "manual") {
      note = "직접 고른 날씨가 모두에게 적용 중이에요. 같은 버튼을 다시 누르면 자동으로 돌아가요.";
    } else if (auto == null) {
      note = `${area} 날씨를 불러오는 중…`;
    } else if (auto === "failed") {
      note = "날씨를 자동으로 불러오지 못했어요. 오늘 날씨를 직접 골라 주세요.";
    } else {
      note = `자동: ${area} 지금 ${auto.temp}°C, ${auto.rainy ? "비·눈 옴" : "비 안 옴"}`;
    }
    const effect = WEATHERS[w.kind].boost ? ` → #${WEATHERS[w.kind].boost} 메뉴 +1` : "";
    $("weather-note").textContent = note + effect;

    $("mood-chips").innerHTML = Object.entries(MOODS).map(([k, v]) =>
      `<button class="chip tap ${state.mood === k ? "active" : ""}" data-mood="${k}" aria-pressed="${state.mood === k}">${v.label}</button>`
    ).join("");

    const emojiOf = (name) => (MENUS.find((m) => m.name === name) || {}).emoji || "🍽";
    const past = Object.values(store.days)
      .filter((d) => d && d.office === state.office && typeof d.menu === "string" && typeof d.date === "string")
      .map((d) => ({ ...d, ago: daysAgo(d.date) }))
      .filter((d) => d.ago >= 1 && d.ago <= RECENT_DAYS)
      .sort((a, b) => a.ago - b.ago);

    let today;
    if (day && typeof day.menu === "string") {
      const shops = shopsOf(day.menu);
      const shopPicker = shops.length
        ? `<label class="today-field">어디서?
            <select id="today-shop">
              <option value="">선택 안 함</option>
              ${shops.map((s) => `<option value="${esc(s.name)}" ${day.shop === s.name ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
            </select></label>`
        : (day.shop ? `<span class="today-field">${esc(day.shop)}</span>` : "");
      today = `
        <div class="today-eaten">
          <span>오늘: ${emojiOf(day.menu)} <strong>${esc(day.menu)}</strong> 먹음</span>
          ${shopPicker}
          ${todayShopStars(day)}
          <button class="ghost small" data-eat="${esc(day.menu)}">기록 취소</button>
        </div>`;
    } else {
      today = `<p class="hint tight">점심을 먹은 뒤 메뉴 옆 🍽 버튼을 누르면 기록돼요. 기록한 메뉴는 ${RECENT_DAYS}일 동안 순위가 1점 내려가고,
        간 가게를 고르면 ⭐ 가게 별점도 줄 수 있어요.</p>`;
    }
    const list = past.length
      ? `<div class="chips">${past.map((d) => {
          const [, m, dd] = d.date.split("-");
          const rate = "";
          const shop = typeof d.shop === "string" && d.shop ? ` · ${esc(d.shop)}` : "";
          return `<span class="chip">${Number(m)}/${Number(dd)} ${emojiOf(d.menu)} ${esc(d.menu)}${shop}${rate} <small>(${d.ago}일 전)</small></span>`;
        }).join("")}</div>`
      : `<p class="hint tight">최근 ${RECENT_DAYS}일 동안 기록이 없어요.</p>`;
    $("history").innerHTML = today + list;
  }

  // =================================================================
  // 카카오맵 근처 가게 찾기
  // =================================================================
  const kakaoKey = () => (typeof KAKAO_JS_KEY === "string" && KAKAO_JS_KEY.trim()) || readJson(KAKAO_KEY_STORAGE, "") || "";
  const kakaoResultKey = (menuName) => `${state.office}|${menuName}`;
  const walkMinutes = (meters) => Math.max(1, Math.round(meters / WALK_METERS_PER_MIN));
  const searchKeyword = (menu) => menu.search || menu.name.split(/[·(]/)[0].trim();
  const officeCoords = {};
  const officeCenter = (k = state.office) => officeCoords[k] || OFFICES[k].location;
  const hasCoords = (r) => r && typeof r.lat === "number" && typeof r.lon === "number" && Number.isFinite(r.lat) && Number.isFinite(r.lon);
  const fmtMeters = (m) => (m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`);
  // 두 좌표 사이 직선 거리(m)
  function distanceM(a, b) {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return Math.round(6371000 * 2 * Math.asin(Math.sqrt(h)));
  }
  const mapNodes = {}; // "사무실|메뉴" → { el, map, bounds } (다시 그려도 지도를 새로 만들지 않도록 보관)
  let kakaoPromise = null;

  function loadKakao() {
    if (kakaoPromise) return kakaoPromise;
    kakaoPromise = new Promise((resolve, reject) => {
      if (window.kakao && window.kakao.maps && window.kakao.maps.services) return resolve(window.kakao);
      const timer = setTimeout(() => reject(new Error("sdk")), 8000);
      const s = document.createElement("script");
      s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(kakaoKey())}&libraries=services&autoload=false`;
      s.onload = () => {
        try {
          window.kakao.maps.load(() => { clearTimeout(timer); resolve(window.kakao); });
        } catch (e) {
          clearTimeout(timer);
          reject(new Error("sdk"));
        }
      };
      s.onerror = () => { clearTimeout(timer); reject(new Error("sdk")); };
      document.head.appendChild(s);
    }).catch((e) => {
      kakaoPromise = null;
      throw e;
    });
    return kakaoPromise;
  }

  // 사무실 주소 → 좌표 (실패하면 data.js 의 대략 좌표)
  function officeLatLng(kakao, officeKey) {
    if (officeCoords[officeKey]) return Promise.resolve(officeCoords[officeKey]);
    const o = OFFICES[officeKey];
    return new Promise((resolve) => {
      new kakao.maps.services.Geocoder().addressSearch(o.address, (res, status) => {
        const ok = status === kakao.maps.services.Status.OK && res[0];
        officeCoords[officeKey] = ok ? { lat: Number(res[0].y), lon: Number(res[0].x) } : o.location;
        resolve(officeCoords[officeKey]);
      });
    });
  }

  // 사무실 좌표를 카카오 주소 검색으로 정확히 (거리 계산용). 실패하면 data.js 의 대략 좌표 그대로
  function refineOfficeCoords() {
    const office = state.office;
    if (!kakaoKey() || officeCoords[office]) return;
    loadKakao().then((k) => officeLatLng(k, office)).then(render).catch(() => {});
  }

  // 가게 이름 → 사무실 근처에서 카카오맵 장소 찾기 (실제 위치 연결)
  async function locatePlace(name) {
    const kakao = await loadKakao();
    const c = await officeLatLng(kakao, state.office);
    const S = kakao.maps.services;
    const places = await new Promise((resolve) => {
      new S.Places().keywordSearch(name, (data, status) => resolve(status === S.Status.OK ? data : []), {
        location: new kakao.maps.LatLng(c.lat, c.lon),
        radius: LOCATE_RADIUS,
        sort: S.SortBy.ACCURACY,
        size: 5,
      });
    });
    const p = places[0];
    if (!p) return null;
    const lat = Number(p.y), lon = Number(p.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, place: p.place_name, ...(isKakaoPlaceUrl(p.place_url) ? { kakaoUrl: p.place_url } : {}) };
  }

  // 위치를 연결하면 별점 기준(가게 id)이 카카오 장소로 바뀌므로, 남긴 별점을 옮김
  async function moveRatings(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey) return;
    for (const [id, r] of Object.entries(store.ratings)) {
      if (!r || r.shop !== fromKey) continue;
      const newId = ratingId(toKey, r.person);
      if (!store.ratings[newId]) await write("ratings", newId, { ...r, shop: toKey });
      await write("ratings", id, null);
    }
  }

  async function searchNearby(menu) {
    const key = kakaoResultKey(menu.name);
    const keyword = searchKeyword(menu);
    state.kakaoResults[key] = { status: "loading", keyword };
    delete mapNodes[key];
    render();
    try {
      const kakao = await loadKakao();
      const c = await officeLatLng(kakao, state.office);
      const S = kakao.maps.services;
      const places = await new Promise((resolve, reject) => {
        new S.Places().keywordSearch(keyword, (data, status) => {
          if (status === S.Status.OK) resolve(data);
          else if (status === S.Status.ZERO_RESULT) resolve([]);
          else reject(new Error("search"));
        }, {
          location: new kakao.maps.LatLng(c.lat, c.lon),
          radius: KAKAO_SEARCH_RADIUS,
          sort: S.SortBy.DISTANCE,
          category_group_code: "FD6",
          size: 10,
        });
      });
      state.kakaoResults[key] = {
        status: "ok",
        keyword,
        center: c,
        items: places.map((p) => ({
          lat: Number(p.y),
          lon: Number(p.x),
          name: p.place_name,
          distance: Number(p.distance) || 0,
          category: (p.category_name || "").split(" > ").pop(),
          address: p.road_address_name || p.address_name || "",
          url: p.place_url,
        })),
      };
    } catch (e) {
      // sdk: 지도 스크립트 자체를 못 불러옴 / search: 스크립트는 됐지만 검색이 거부됨
      state.kakaoResults[key] = { status: "error", keyword, stage: e && e.message === "sdk" ? "sdk" : "search" };
    }
    render();
  }

  const isKakaoPlaceUrl = (u) => typeof u === "string" && /^https?:\/\/place\.map\.kakao\.com\/\d+$/.test(u);

  function renderKakao(m) {
    if (!kakaoKey()) {
      return `
        <form class="kakao-key" data-kakao-key>
          <span class="hint tight">카카오맵으로 근처 가게를 찾으려면 카카오 JavaScript 키가 필요해요.</span>
          <input id="kakao-key-${m.index}" name="key" placeholder="카카오 JavaScript 키" autocomplete="off" required />
          <button class="primary small" type="submit">키 저장</button>
        </form>`;
    }
    const r = state.kakaoResults[kakaoResultKey(m.name)];
    const saved = new Set(shopsOf(m.name).map((s) => s.name));
    const ratings = shopRatings();
    const radius = KAKAO_SEARCH_RADIUS >= 1000 ? `${KAKAO_SEARCH_RADIUS / 1000}km` : `${KAKAO_SEARCH_RADIUS}m`;
    let body = "";
    if (r && r.status === "loading") {
      body = `<p class="hint tight">'${esc(r.keyword)}' 찾는 중…</p>`;
    } else if (r && r.status === "error") {
      body = r.stage === "sdk"
        ? `<p class="hint tight error"><b>[1단계 실패] 카카오 지도 스크립트를 불러오지 못했어요.</b><br>
            카카오 개발자 사이트에서 JavaScript 키가 맞는지, <b>JavaScript SDK 도메인</b>(또는 플랫폼 → Web 사이트 도메인)에
            <b>${esc(location.origin)}</b> 이 등록됐는지 확인해 주세요. claude.ai 링크 안에서는 보안 정책 때문에 동작하지 않아요.</p>`
        : `<p class="hint tight error"><b>[2단계 실패] 지도 스크립트는 불러왔지만 카카오가 장소 검색을 거부했어요.</b><br>
            카카오 개발자 사이트의 <b>제품 설정 → 카카오맵</b>에서 <b>사용 설정을 ON</b>으로 켰는지 확인해 주세요.
            도메인 등록(<b>${esc(location.origin)}</b>)이 빠져도 이렇게 될 수 있어요.</p>`;
    } else if (r && r.status === "ok") {
      body = r.items.length
        ? `<div class="kakao-map-slot" data-map-key="${esc(kakaoResultKey(m.name))}"></div>
          <ul class="kakao-list">${r.items.map((p, i) => `
            <li>
              <span class="pin-no">${i + 1}</span>
              ${isKakaoPlaceUrl(p.url) ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : `<strong>${esc(p.name)}</strong>`}
              <span class="shop-meta">${esc(p.category)} · ${p.distance}m · 도보 ${walkMinutes(p.distance)}분${
                ratings.get(shopKey(p)) ? ` · 우리 별점 ${ratingText(ratings.get(shopKey(p)))}` : ""}</span>
              ${isKakaoPlaceUrl(p.url) ? `<a class="review-link" href="${esc(p.url)}" target="_blank" rel="noopener">⭐ 별점·리뷰</a>` : ""}
              ${saved.has(p.name)
                ? `<span class="saved">저장됨 ✓</span>`
                : `<button class="ghost small" data-kakao-save="${m.index}:${i}">➕ 우리 가게로 저장</button>`}
            </li>`).join("")}</ul>`
        : `<p class="hint tight">사무실 반경 ${radius} 안에 '${esc(r.keyword)}' 가게가 없어요.</p>`;
    }
    const reset = typeof KAKAO_JS_KEY === "string" && KAKAO_JS_KEY.trim()
      ? "" : `<button class="link-button" data-kakao-key-reset>키 다시 입력</button>`;
    return `
      <div class="kakao">
        <div class="kakao-head">
          <button class="primary small" data-kakao-search="${m.index}">${r && r.status === "ok" ? "🔄 다시 찾기" : `📍 카카오맵으로 반경 ${radius} 가게 찾기`}</button>
          ${reset}
        </div>
        ${body}
      </div>`;
  }

  // 지도에 올릴 것: 카카오 검색 결과, 또는 "saved|사무실|메뉴|…" = 위치가 연결된 우리 가게
  function mapSource(key) {
    if (key.startsWith("saved|")) {
      const [, office, menu] = key.split("|");
      if (office !== state.office) return null;
      const items = shopsOf(menu).filter((s) => s.meters != null)
        .map((s) => ({ lat: s.lat, lon: s.lon, name: s.name, distance: s.meters }));
      return { center: officeCenter(), items };
    }
    const r = state.kakaoResults[key];
    return r && r.status === "ok" && r.center ? r : null;
  }

  // 지도: 사무실 🏢 + 가게 번호 핀
  function mountMaps() {
    const kakao = window.kakao;
    if (!kakao || !kakao.maps || !kakao.maps.Map) return;
    document.querySelectorAll(".kakao-map-slot").forEach((slot) => {
      const key = slot.dataset.mapKey;
      const r = mapSource(key);
      if (!r || !r.items.length) return;
      let node = mapNodes[key];
      if (node) {
        slot.replaceWith(node.el);
        node.map.relayout();
        node.map.setBounds(node.bounds);
        return;
      }
      const el = document.createElement("div");
      el.className = "kakao-map";
      slot.replaceWith(el);
      const officePos = new kakao.maps.LatLng(r.center.lat, r.center.lon);
      const map = new kakao.maps.Map(el, { center: officePos, level: 4 });
      const bounds = new kakao.maps.LatLngBounds();
      new kakao.maps.CustomOverlay({ map, position: officePos, content: `<div class="pin office">🏢 사무실</div>`, yAnchor: 1.2, zIndex: 2 });
      bounds.extend(officePos);
      r.items.forEach((p, i) => {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
        const pos = new kakao.maps.LatLng(p.lat, p.lon);
        // 번호 핀 + 마우스를 올리면(휴대폰은 탭하면) 가게 이름 말풍선
        const pin = document.createElement("div");
        pin.className = "pin";
        pin.tabIndex = 0;
        pin.textContent = String(i + 1);
        const tip = document.createElement("span");
        tip.className = "pin-tip";
        tip.textContent = `${p.name} · ${fmtMeters(p.distance)} · 도보 ${walkMinutes(p.distance)}분`;
        pin.appendChild(tip);
        const overlay = new kakao.maps.CustomOverlay({ map, position: pos, content: pin, yAnchor: 1.1, zIndex: 1 });
        const raise = () => overlay.setZIndex(10);
        const lower = () => overlay.setZIndex(1);
        pin.addEventListener("mouseenter", raise);
        pin.addEventListener("mouseleave", lower);
        pin.addEventListener("focus", raise);
        pin.addEventListener("blur", lower);
        bounds.extend(pos);
      });
      map.setBounds(bounds);
      mapNodes[key] = { el, map, bounds };
    });
  }

  // 저장한 가게 + 사무실과의 거리 (위치가 연결된 가게는 좌표로 계산, 아니면 직접 입력한 도보 시간)
  function shopsOf(menuName) {
    const center = officeCenter();
    return Object.entries(store.restaurants)
      .map(([id, r]) => {
        const meters = hasCoords(r) ? distanceM(center, r) : null;
        const walkMin = meters != null ? walkMinutes(meters) : Number(r.walk) > 0 ? Number(r.walk) : null;
        return { id, ...r, meters, walkMin };
      })
      .filter((r) => r.office === state.office && r.menu === menuName && typeof r.name === "string")
      .sort((a, b) => (a.walkMin || 99) - (b.walkMin || 99) || (a.meters || 0) - (b.meters || 0));
  }

  function renderShops(m) {
    const shops = shopsOf(m.name);
    const ratings = shopRatings();
    const area = OFFICES[state.office].area || "";
    const query = `${area} ${searchKeyword(m)}`.trim();
    const located = shops.filter((r) => r.meters != null);
    // 지도는 가게 목록이 바뀌면 새로 그림
    const mapKey = `saved|${state.office}|${m.name}|${officeCoords[state.office] ? "k" : "a"}|${located.map((r) => r.id).join(",")}`;
    const items = shops.length
      ? `${located.length && window.kakao && window.kakao.maps ? `<div class="kakao-map-slot" data-map-key="${esc(mapKey)}"></div>` : ""}
        <ul class="shop-list">${shops.map((r) => {
          const meta = [
            r.meters != null ? `📍 사무실에서 ${fmtMeters(r.meters)} · 도보 ${r.walkMin}분` : r.walkMin ? `도보 ${r.walkMin}분 (직접 입력)` : "",
            Number(r.price) > 0 ? `${Number(r.price).toLocaleString("ko-KR")}원` : "",
            r.place && r.place !== r.name ? `카카오맵: ${esc(r.place)}` : "",
          ].filter(Boolean).join(" · ");
          const pinNo = r.meters != null ? located.indexOf(r) + 1 : 0;
          const confirming = state.confirmDelete === r.id;
          const href = isKakaoPlaceUrl(r.kakaoUrl)
            ? r.kakaoUrl : `https://map.kakao.com/link/search/${encodeURIComponent(area + " " + r.name)}`;
          return `<li>
            ${pinNo ? `<span class="pin-no">${pinNo}</span>` : ""}
            <a href="${esc(href)}" target="_blank" rel="noopener">${esc(r.name)}</a>
            ${meta ? `<span class="shop-meta">${meta}</span>` : ""}
            ${r.meters == null && kakaoKey() ? `<button class="ghost small" data-locate-shop="${esc(r.id)}" title="카카오맵에서 실제 위치를 찾아 거리를 계산해요">📍 위치 찾기</button>` : ""}
            <button class="ghost small ${confirming ? "danger" : ""}" data-del-shop="${esc(r.id)}">${confirming ? "정말 삭제?" : "삭제"}</button>
            <div class="shop-rating">${shopStarsHtml(shopKey(r), r.name, ratings)}</div>
          </li>`;
        }).join("")}</ul>`
      : `<p class="hint tight">아직 등록된 가게가 없어요. 자주 가는 곳을 추가해 주세요.</p>`;
    return `
      <div class="shops">
        ${renderKakao(m)}
        ${items}
        <form class="shop-form" data-add-shop="${m.index}">
          <input id="shop-name-${m.index}" name="name" placeholder="가게 이름" maxlength="40" required />
          <input id="shop-walk-${m.index}" name="walk" type="number" min="0" max="60" inputmode="numeric" placeholder="도보(분)" title="카카오맵에서 위치를 찾으면 자동으로 계산돼요" />
          <input id="shop-price-${m.index}" name="price" type="number" min="0" step="500" inputmode="numeric" placeholder="1인 가격(원)" />
          <button class="primary small" type="submit">추가</button>
        </form>
        <div class="map-links">
          <a class="map-link" href="https://map.kakao.com/link/search/${encodeURIComponent(query)}" target="_blank" rel="noopener">카카오맵에서 '${esc(query)}' 보기 ↗</a>
          <a class="map-link" href="https://map.naver.com/p/search/${encodeURIComponent(query)}" target="_blank" rel="noopener">네이버 지도 ↗</a>
        </div>
      </div>`;
  }

  function renderMenus() {
    // 다른 사람이 저장해서 다시 그려져도 입력 중인 글자는 유지
    const active = document.activeElement && document.activeElement.id;
    const typed = {};
    $("menus").querySelectorAll("input[id]").forEach((el) => { typed[el.id] = el.value; });

    const all = scoreMenus();
    const ranked = visibleMenus();
    const hidden = all.filter((m) => m.downs.length || m.allergic.length);
    $("hidden-summary").hidden = !state.hideDisliked;
    $("hidden-summary").textContent = hidden.length
      ? `누군가 싫어하거나 알레르기가 있는 메뉴 ${hidden.length}개를 숨겼어요: ${hidden.map((m) => m.name).join(", ")}`
      : "숨긴 메뉴가 없어요. 체크한 사람 중 아무도 싫어하는 메뉴가 없습니다.";

    // 오늘 같이 먹는 사람 중 알레르기 있는 사람 안내
    const allergyPeople = selectedPeople()
      .map((p) => ({ name: p.name, list: prefsOf(p).allergies }))
      .filter((x) => x.list.length);
    const risky = all.filter((m) => m.allergic.length).length;
    $("allergy-summary").hidden = !allergyPeople.length;
    $("allergy-summary").innerHTML = allergyPeople.length
      ? `⚠️ <b>오늘 알레르기</b>: ${allergyPeople.map((x) => `${esc(x.name)}님(${esc(x.list.join(", "))})`).join(", ")}
         → 해당 재료가 들어갈 수 있는 메뉴 ${risky}개는 맨 아래로 내리고 룰렛에서 뺐어요. 가게마다 재료가 다르니 주문할 때 꼭 물어보세요.`
      : "";

    const eatenToday = (todayDoc() || {}).menu;
    const fmt = (list) => esc(list.map((r) => `${r.who}님(${r.tags.join(", ")})`).join(", "));

    $("menus").innerHTML = ranked.map((m, i) => {
      const cls = m.allergic.length ? "allergy" : m.score > 0 ? "good" : m.score < 0 ? "bad" : "";
      const badge = m.allergic.length ? "⚠️ 알레르기" : m.score > 0 ? `추천 +${m.score}` : m.score < 0 ? `비추 ${m.score}` : "";
      const reasons = [
        m.allergic.length ? `<div class="allergy-line">⚠️ 알레르기 주의: ${fmt(m.allergic)}</div>` : "",
        m.ups.length ? `<div class="up">👍 ${fmt(m.ups)}</div>` : "",
        m.downs.length ? `<div class="down">👎 ${fmt(m.downs)}</div>` : "",
        ...m.extras.map((x) => `<div class="${x.delta > 0 ? "up" : "down"}">${x.text} ${x.delta > 0 ? "+1" : "-1"}</div>`),
      ].join("");
      const shops = shopsOf(m.name);
      const shopCount = shops.length;
      const nearest = shops.find((r) => r.walkMin);
      const open = state.openShops.has(m.name);
      const ate = eatenToday === m.name;
      return `
        <li class="menu ${cls}" data-menu="${esc(m.name)}">
          <span class="rank">${i + 1}</span>
          <span class="emoji">${m.emoji}</span>
          <div class="menu-body">
            <div class="title">${m.name}${ate ? ` <span class="ate">오늘 먹음 ✓</span>` : ""}</div>
            <div class="tags">${m.tags.map((t) => `<span class="tag">#${t}</span>`).join("")}</div>
            ${reasons ? `<div class="reasons">${reasons}</div>` : ""}
            <div class="row-actions">
              <button class="ghost small ${ate ? "on" : ""}" data-eat="${esc(m.name)}">${ate ? "🍽 기록 취소" : "🍽 오늘 이거 먹었어요"}</button>
              <button class="ghost small" data-shops="${esc(m.name)}" aria-expanded="${open}">🏪 근처 가게 ${shopCount}${nearest ? ` · 가장 가까운 곳 도보 ${nearest.walkMin}분` : ""} ${open ? "▴" : "▾"}</button>
            </div>
          </div>
          ${badge ? `<span class="badge">${badge}</span>` : "<span></span>"}
          ${open ? renderShops(m) : ""}
        </li>`;
    }).join("");

    mountMaps();
    Object.entries(typed).forEach(([id, v]) => { const el = $(id); if (el) el.value = v; });
    if (active && $(active)) $(active).focus();
  }

  function renderOfficeAddress() {
    const o = OFFICES[state.office];
    $("office-address").innerHTML = o.address
      ? `📍 <strong>${esc(o.place || o.label)}</strong> · ${esc(o.address)} ${esc(o.addressDetail || "")}
         <a href="https://map.kakao.com/link/search/${encodeURIComponent(o.address)}" target="_blank" rel="noopener">카카오맵에서 보기 ↗</a>`
      : "";
  }

  // =================================================================
  // 사용 통계 + 메뉴 추가 요청
  // =================================================================
  let statsOpen = false;

  function computeStats() {
    const inLast = (date, n) => typeof date === "string" && daysAgo(date) >= 0 && daysAgo(date) < n;
    const people = allPeople();
    const checkins = Object.values(store.checkins).filter((c) => c && OFFICES[c.office] && typeof c.date === "string" && typeof c.person === "string");
    const meals = Object.values(store.days).filter((d) => d && OFFICES[d.office] && typeof d.menu === "string" && typeof d.date === "string");

    const perOffice = Object.keys(OFFICES).map((key) => {
      const ci7 = checkins.filter((c) => c.office === key && inLast(c.date, 7));
      const ci30 = checkins.filter((c) => c.office === key && inLast(c.date, 30));
      const meals7 = meals.filter((d) => d.office === key && inLast(d.date, 7));
      const meals30 = meals.filter((d) => d.office === key && inLast(d.date, 30));
      const days7 = new Set([...ci7.map((c) => c.date), ...meals7.map((d) => d.date)]);
      const ciDays30 = new Set(ci30.map((c) => c.date));
      const recorded30 = meals30.filter((d) => ciDays30.has(d.date)).length;
      return {
        key,
        members: people.filter((p) => p.office === key).length,
        days7: days7.size,
        avgGroup: ciDays30.size ? ci30.length / ciDays30.size : 0,
        recordRate: ciDays30.size ? recorded30 / ciDays30.size : null,
      };
    });

    const menuCount = new Map();
    meals.filter((d) => inLast(d.date, 30)).forEach((d) => menuCount.set(d.menu, (menuCount.get(d.menu) || 0) + 1));
    const ratings = shopRatings();

    const requests = new Map();
    Object.values(store.requests).forEach((r) => {
      if (!r || typeof r.name !== "string" || !r.name.trim()) return;
      const key = r.name.trim().replace(/\s+/g, " ");
      const s = requests.get(key.toLowerCase()) || { name: key, count: 0, last: "" };
      s.count += 1;
      if (typeof r.at === "string" && r.at > s.last) s.last = r.at;
      requests.set(key.toLowerCase(), s);
    });

    return {
      members: people.length,
      checkins7: checkins.filter((c) => inLast(c.date, 7)).length,
      meals30: meals.filter((d) => inLast(d.date, 30)).length,
      perOffice,
      topMenus: [...menuCount].sort((x, y) => y[1] - x[1]).slice(0, 5),
      topShops: [...ratings.values()].filter((s) => s.name)
        .sort((x, y) => avgOf(y) - avgOf(x) || y.count - x.count).slice(0, 5),
      requests: [...requests.values()].sort((x, y) => y.count - x.count || y.last.localeCompare(x.last)),
    };
  }

  function renderStats() {
    $("stats-panel").hidden = !statsOpen;
    if (!statsOpen) return;
    const s = computeStats();
    const pct = (v) => v == null ? "–" : `${Math.round(v * 100)}%`;
    const emojiOf = (name) => (MENUS.find((m) => m.name === name) || {}).emoji || "🍽";
    const tiles = [
      ["가입한 사람", `${s.members}명`],
      ["최근 7일 출석", `${s.checkins7}회`],
      ["최근 30일 먹은 기록", `${s.meals30}번`],
    ].map(([k, v]) => `<div class="stat-tile"><div class="stat-value">${v}</div><div class="stat-label">${k}</div></div>`).join("");
    const officeRows = s.perOffice.map((o) => `<tr><td>${officeShort(o.key)}</td><td>${o.members}명</td><td>${o.days7}일</td><td>${o.avgGroup ? o.avgGroup.toFixed(1) + "명" : "–"}</td><td>${pct(o.recordRate)}</td></tr>`).join("");
    const menuRows = s.topMenus.length
      ? s.topMenus.map(([name, n], i) => `<tr><td>${i + 1}</td><td>${emojiOf(name)} ${esc(name)}</td><td>${n}번</td></tr>`).join("")
      : `<tr><td colspan="3" class="empty">아직 먹은 기록이 없어요. 점심 후 🍽 버튼으로 기록해 주세요.</td></tr>`;
    const shopRows = s.topShops.length
      ? s.topShops.map((x) => `<tr><td>${esc(x.name)}</td><td>${officeShort(x.office)}</td><td>${ratingText(x)}</td></tr>`).join("")
      : `<tr><td colspan="3" class="empty">아직 가게 별점이 없어요. 근처 가게 목록에서 ⭐를 눌러 주세요.</td></tr>`;
    const reqRows = s.requests.length
      ? s.requests.map((r) => `<li><span>${esc(r.name)}</span><span class="req-count">${r.count}명 요청</span></li>`).join("")
      : `<li class="empty">아직 요청이 없어요.</li>`;

    $("stats-body").innerHTML = `
      <div class="stats-head">
        <h2 id="stats-title">📊 사용 통계</h2>
        <button class="ghost small" data-close-stats>닫기</button>
      </div>
      <div class="stat-tiles">${tiles}</div>

      <h3>사무실별</h3>
      <div class="table-wrap"><table class="stats-table">
        <thead><tr><th>사무실</th><th>가입자</th><th>최근 7일 쓴 날</th><th>평균 인원</th><th>먹은 기록 비율</th></tr></thead>
        <tbody>${officeRows}</tbody>
      </table></div>
      <p class="hint tight">평균 인원·기록 비율은 최근 30일 중 출석한 날 기준이에요. 기록 비율은 출석한 날 중 🍽 먹은 기록까지 남긴 날의 비율이에요.</p>

      <h3>인기 메뉴 (최근 30일)</h3>
      <div class="table-wrap"><table class="stats-table">
        <thead><tr><th>순위</th><th>메뉴</th><th>먹은 횟수</th></tr></thead>
        <tbody>${menuRows}</tbody>
      </table></div>

      <h3>별점 높은 가게</h3>
      <div class="table-wrap"><table class="stats-table">
        <thead><tr><th>가게</th><th>사무실</th><th>우리 별점</th></tr></thead>
        <tbody>${shopRows}</tbody>
      </table></div>

      <h3 id="requests-title">🍽 메뉴 추가 요청</h3>
      <p class="hint tight">찾는 메뉴가 없으면 요청해 주세요. 관리자가 보고 메뉴 목록에 추가해요.</p>
      <form class="request-form" id="request-form">
        <input id="request-name" maxlength="20" autocomplete="off" placeholder="예: 마라롱샤" required />
        <button class="primary small" type="submit">요청하기</button>
      </form>
      <ul class="request-list">${reqRows}</ul>`;
  }

  function openStats(focusRequest = false) {
    statsOpen = true;
    renderStats();
    if (focusRequest) {
      $("requests-title").scrollIntoView({ block: "start" });
      $("request-name").focus();
    } else {
      $("stats-body").querySelector("[data-close-stats]").focus();
    }
  }

  function closeStats() {
    statsOpen = false;
    renderStats();
  }

  // 상단 안내 띠: 가입 전이면 가입 안내, 로그인했는데 오늘 출석 전이면 출석 안내
  let nudgeClosed = "";
  function renderNudge() {
    const box = $("nudge");
    let kind = "", html = "";
    if (store.mode !== "connecting" && !(session && personById(session.id))) {
      kind = "join";
      html = `<span>👋 <b>처음이세요?</b> 이름과 제일 좋아하는 음식만 있으면 30초 만에 가입하고, 내 취향이 모두의 추천에 반영돼요.</span>
        <button class="primary small" data-nudge="join">가입하기</button>`;
    } else if (session && personById(session.id) && !myCheckin()) {
      kind = "checkin";
      html = `<span>🍽 오늘 <b>${officeShort(state.office)}</b>에서 점심 드세요? 출석하면 오늘 명단에 들어가요.</span>
        <button class="primary small" data-nudge="checkin">🙋 출석하기</button>`;
    }
    box.hidden = !kind || nudgeClosed === kind;
    if (!box.hidden) box.innerHTML = `${html}<button class="nudge-close" data-nudge="close" aria-label="안내 닫기">×</button>`;
    box.dataset.kind = kind;
  }

  function render() {
    renderMeButton();
    renderNudge();
    if (statsOpen) {
      const typed = $("request-name") ? $("request-name").value : "";
      const scroll = $("stats-body").scrollTop;
      renderStats();
      $("request-name").value = typed;
      $("stats-body").scrollTop = scroll;
    }
    renderTabs();
    renderSync();
    renderOfficeAddress();
    const office = OFFICES[state.office];
    const ready = !!office.address;
    $("office-view").hidden = !ready;
    $("coming-soon").hidden = ready;
    if (!ready) {
      $("coming-soon-title").textContent = office.label;
      return;
    }
    renderPeople();
    renderFocus();
    renderConditions();
    renderMenus();
    $("hide-disliked").checked = state.hideDisliked;
  }

  let toastTimer;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // =================================================================
  // 룰렛
  // =================================================================
  function drawWheel() {
    const r = state.roulette;
    const canvas = $("wheel");
    const ctx = canvas.getContext("2d");
    const size = canvas.width;
    const c = size / 2;
    const radius = c - 8;
    const n = r.pool.length;
    const seg = (Math.PI * 2) / n;
    ctx.clearRect(0, 0, size, size);

    for (let i = 0; i < n; i++) {
      const start = r.rotation + i * seg - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, radius, start, start + seg);
      ctx.closePath();
      ctx.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length];
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(start + seg / 2);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#1f2937";
      const fontSize = n > 8 ? 22 : 28;
      ctx.font = `700 ${fontSize}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
      const label = `${r.pool[i].name} ${r.pool[i].emoji}`;
      ctx.fillText(label.length > 10 ? r.pool[i].name.slice(0, 7) + "…" : label, radius - 18, 0);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(c, c, 34, 0, Math.PI * 2);
    ctx.fillStyle = "#4f6b8f";
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 26px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("GO", c, c);
  }

  function spin() {
    const r = state.roulette;
    if (r.spinning) return;
    const n = r.pool.length;
    const seg = (Math.PI * 2) / n;
    const idx = Math.floor(Math.random() * n);
    const full = Math.PI * 2;
    // 포인터(위쪽)가 idx 칸의 가운데에 오도록 하는 회전값
    const base = -(idx + 0.5) * seg;
    const target = base + full * Math.ceil((r.rotation - base) / full) + full * 5;
    const from = r.rotation;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduce ? 0 : 4200;
    const t0 = performance.now();

    r.spinning = true;
    r.choice = null;
    $("roulette-result").textContent = n === 1 ? "1등이 하나뿐이에요!" : `${r.note || ""}${n}개 중에서 고르는 중…`;
    $("roulette-eat").hidden = true;
    $("roulette-again").hidden = true;

    const step = (now) => {
      if (state.roulette !== r) return; // 도는 중에 닫음
      const t = duration ? Math.min(1, (now - t0) / duration) : 1;
      const eased = 1 - Math.pow(1 - t, 3);
      r.rotation = from + (target - from) * eased;
      drawWheel();
      if (t < 1) return requestAnimationFrame(step);
      r.rotation = target % full;
      r.spinning = false;
      r.choice = r.pool[idx];
      $("roulette-result").textContent = `🎉 오늘의 점심은 ${r.choice.emoji} ${r.choice.name}!`;
      $("roulette-eat").hidden = false;
      $("roulette-again").hidden = n === 1;
    };
    requestAnimationFrame(step);
  }

  function openRoulette() {
    const ranked = visibleMenus().filter((m) => m.allergic.length === 0); // 알레르기 메뉴는 룰렛에 안 올림
    if (!ranked.length) return toast("보여줄 메뉴가 없어요. 숨기기 모드를 꺼 보세요.");
    const top = ranked[0].score;
    let pool = ranked.filter((m) => m.score === top);
    let note = "";
    if (pool.length > MAX_WHEEL) {
      note = `공동 1등이 ${pool.length}개라 무작위 ${MAX_WHEEL}개만 올렸어요. `;
      pool = [...pool].sort(() => Math.random() - 0.5).slice(0, MAX_WHEEL);
    }
    state.roulette = { pool, rotation: 0, spinning: false, choice: null, note };
    $("roulette").hidden = false;
    $("roulette-close").focus();
    drawWheel();
    spin();
  }

  function closeRoulette() {
    $("roulette").hidden = true;
    state.roulette = null;
    $("pick").focus();
  }

  // =================================================================
  // 이벤트
  // =================================================================
  $("tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    state.office = tab.dataset.office;
    render();
    if (OFFICES[state.office].location) loadWeather(state.office);
  });

  function focusOn(id) {
    state.lastClicked = id;
  }

  $("people").addEventListener("click", (e) => {
    const remove = e.target.closest("[data-remove]");
    if (remove) return checkOut(remove.dataset.remove);
    const btn = e.target.closest(".person");
    if (!btn) return;
    focusOn(btn.dataset.id);
    render();
  });

  function togglePick(id) {
    focusOn(id);
    return selectedIds().has(id) ? checkOut(id) : checkIn(id);
  }

  $("people-results").addEventListener("click", (e) => {
    const t = e.target.closest("[data-pick]");
    if (!t) return;
    togglePick(t.dataset.pick);
    state.query = "";
    $("people-search").value = "";
    render();
    $("people-search").focus();
  });

  $("people-search").addEventListener("input", (e) => {
    state.query = e.target.value;
    renderPeople();
  });

  // 엔터: 검색 결과 첫 번째 사람 추가
  $("people-search").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    const q = state.query.trim();
    const ids = selectedIds();
    const first = q && allPeople().find((p) => p.name.includes(q) && !ids.has(p.id));
    if (!first) return;
    togglePick(first.id);
    state.query = "";
    e.target.value = "";
    render();
  });

  $("focus").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if ("openMe" in t.dataset) openMe();
    if (t.dataset.loginAs) openMe(t.dataset.loginAs);
  });

  $("weather-chips").addEventListener("click", (e) => {
    const t = e.target.closest("[data-weather]");
    if (!t) return;
    const day = todayDoc();
    // 직접 고른 날씨를 다시 누르면 자동으로
    updateToday({ weather: day && day.weather === t.dataset.weather ? null : t.dataset.weather });
  });

  $("mood-chips").addEventListener("click", (e) => {
    const t = e.target.closest("[data-mood]");
    if (!t) return;
    state.mood = t.dataset.mood;
    saveSettings();
    render();
  });

  async function toggleEaten(name) {
    const day = todayDoc();
    const undo = day && day.menu === name;
    const changed = !day || day.menu !== name;
    const ok = await updateToday(undo || changed ? { menu: undo ? null : name, shop: null, rating: null } : { menu: name });
    if (ok) toast(undo ? "오늘 기록을 지웠어요." : `오늘 ${name} 먹은 걸로 기록했어요.`);
  }

  $("history").addEventListener("click", async (e) => {
    const eat = e.target.closest("[data-eat]");
    if (eat) return toggleEaten(eat.dataset.eat);

  });

  $("history").addEventListener("change", (e) => {
    if (e.target.id === "today-shop") updateToday({ shop: e.target.value || null });
  });

  // 가게 별점 누르기 (근처 가게 목록, 오늘 간 가게 어디서든)
  document.addEventListener("click", async (e) => {
    if (e.target.closest("[data-star-login]")) return openMe();
    const half = e.target.closest("[data-stars]");
    const group = half && half.closest("[data-shop-key]");
    if (!group || !session) return;
    const key = group.dataset.shopKey;
    const name = group.dataset.shopName;
    const stars = Number(half.dataset.stars);
    const id = ratingId(key, session.id);
    const cur = store.ratings[id];
    const clear = cur && cur.stars === stars; // 같은 점수를 다시 누르면 지움
    const ok = clear
      ? await write("ratings", id, null)
      : await write("ratings", id, { shop: key, name, office: state.office, person: session.id, stars, at: new Date().toISOString() });
    if (ok) toast(clear ? `${name} 별점을 지웠어요.` : `${name}에 별점 ${stars.toFixed(1)}점을 줬어요.`);
  });

  $("menus").addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.eat) return toggleEaten(t.dataset.eat);
    if (t.dataset.shops) {
      const name = t.dataset.shops;
      state.openShops.has(name) ? state.openShops.delete(name) : state.openShops.add(name);
      if (state.openShops.has(name)) refineOfficeCoords();
      return render();
    }
    if (t.dataset.kakaoSearch) return searchNearby(MENUS[Number(t.dataset.kakaoSearch)]);
    if ("kakaoKeyReset" in t.dataset) {
      writeJson(KAKAO_KEY_STORAGE, "");
      if (!window.kakao) kakaoPromise = null;
      state.kakaoResults = {};
      return render();
    }
    if (t.dataset.kakaoSave) {
      const [mi, pi] = t.dataset.kakaoSave.split(":").map(Number);
      const menu = MENUS[mi];
      const r = state.kakaoResults[kakaoResultKey(menu.name)];
      const p = r && r.items && r.items[pi];
      if (!p) return;
      const id = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const ok = await write("restaurants", id, {
        office: state.office,
        menu: menu.name,
        name: p.name,
        walk: walkMinutes(p.distance),
        price: 0,
        place: p.name,
        ...(isKakaoPlaceUrl(p.url) ? { kakaoUrl: p.url } : {}),
        ...(Number.isFinite(p.lat) ? { lat: p.lat, lon: p.lon } : {}),
      });
      if (ok) toast(`${menu.name}에 '${p.name}'을(를) 저장했어요.`);
      return;
    }
    if (t.dataset.locateShop) {
      const id = t.dataset.locateShop;
      const r = store.restaurants[id];
      if (!r) return;
      t.disabled = true;
      t.textContent = "찾는 중…";
      const loc = await locatePlace(r.name).catch(() => null);
      if (!loc) {
        t.disabled = false;
        t.textContent = "📍 위치 찾기";
        return toast(`카카오맵에서 '${r.name}'을(를) 못 찾았어요. 카카오맵에 나오는 가게 이름으로 다시 추가해 주세요.`);
      }
      const oldKey = shopKey({ id, ...r });
      const next = { ...r, ...loc, walk: walkMinutes(distanceM(officeCenter(), loc)) };
      if (await write("restaurants", id, next)) {
        await moveRatings(oldKey, shopKey({ id, ...next }));
        toast(`'${r.name}' 위치를 연결했어요: ${loc.place} · 사무실에서 ${fmtMeters(distanceM(officeCenter(), loc))}`);
      }
      return;
    }
    if (t.dataset.delShop) {
      const id = t.dataset.delShop;
      if (state.confirmDelete !== id) {
        state.confirmDelete = id;
        render();
        setTimeout(() => { if (state.confirmDelete === id) { state.confirmDelete = null; render(); } }, 3000);
        return;
      }
      state.confirmDelete = null;
      if (await write("restaurants", id, null)) toast("가게를 지웠어요.");
    }
  });

  $("menus").addEventListener("submit", async (e) => {
    const keyForm = e.target.closest("[data-kakao-key]");
    if (keyForm) {
      e.preventDefault();
      const key = String(new FormData(keyForm).get("key") || "").trim();
      if (!key) return;
      writeJson(KAKAO_KEY_STORAGE, key);
      toast("카카오 키를 이 브라우저에 저장했어요.");
      return render();
    }
    const form = e.target.closest("[data-add-shop]");
    if (!form) return;
    e.preventDefault();
    const menu = MENUS[Number(form.dataset.addShop)];
    const fd = new FormData(form);
    const name = String(fd.get("name") || "").trim();
    if (!name) return;
    const id = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const button = form.querySelector("button[type=submit]");
    if (button) button.disabled = true;
    // 카카오맵에서 실제 위치를 찾으면 좌표·거리를 같이 저장
    const loc = kakaoKey() ? await locatePlace(name).catch(() => null) : null;
    const meters = loc ? distanceM(officeCenter(), loc) : null;
    const ok = await write("restaurants", id, {
      office: state.office,
      menu: menu.name,
      name,
      walk: loc ? walkMinutes(meters) : Math.max(0, Number(fd.get("walk")) || 0),
      price: Math.max(0, Number(fd.get("price")) || 0),
      ...(loc || {}),
    });
    if (button) button.disabled = false;
    if (ok) {
      ["name", "walk", "price"].forEach((f) => { const el = $(`shop-${f}-${form.dataset.addShop}`); if (el) el.value = ""; });
      toast(loc
        ? `${menu.name}에 '${name}'을(를) 추가했어요. 카카오맵 위치 연결: ${loc.place} · 사무실에서 ${fmtMeters(meters)}`
        : `${menu.name}에 '${name}'을(를) 추가했어요.`);
    }
  });

  $("select-all").addEventListener("click", async () => {
    const ids = selectedIds();
    const todo = officePeople().filter((p) => !ids.has(p.id));
    for (const p of todo) { if (!(await checkIn(p.id))) return; }
    toast(todo.length ? `주 사무실이 ${officeShort(state.office)}인 ${todo.length}명을 오늘 명단에 넣었어요.` : "이미 모두 들어 있어요.");
  });

  // 명단은 모두가 같이 쓰므로 비우기는 두 번 눌러야 함
  let clearArmed = null;
  $("clear-all").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (!clearArmed) {
      btn.textContent = "정말 모두 뺄까요?";
      btn.classList.add("danger");
      clearArmed = setTimeout(() => { clearArmed = null; btn.textContent = "초기화"; btn.classList.remove("danger"); }, 3000);
      return;
    }
    clearTimeout(clearArmed); clearArmed = null;
    btn.textContent = "초기화"; btn.classList.remove("danger");
    for (const c of todaysCheckins()) { if (!(await checkOut(c.person))) return; }
    state.lastClicked = null;
    toast(`오늘 ${officeShort(state.office)} 명단을 비웠어요.`);
    render();
  });

  $("open-stats").addEventListener("click", () => openStats());
  $("open-request").addEventListener("click", () => openStats(true));
  $("stats-panel").addEventListener("click", (e) => {
    if (e.target === $("stats-panel") || e.target.closest("[data-close-stats]")) closeStats();
  });
  $("stats-panel").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("request-name").value.trim().replace(/\s+/g, " ");
    if (!name) return;
    const known = MENUS.find((m) => m.name.replace(/\s/g, "").includes(name.replace(/\s/g, "")));
    if (known) return toast(`'${known.name}'이(가) 이미 메뉴에 있어요.`);
    const id = "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (await write("requests", id, { name, by: session ? session.id : null, at: new Date().toISOString() })) {
      $("request-name").value = "";
      toast(`'${name}' 메뉴를 요청했어요. 고마워요!`);
      renderStats();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && statsOpen) closeStats();
  });

  $("nudge").addEventListener("click", (e) => {
    const t = e.target.closest("[data-nudge]");
    if (!t) return;
    if (t.dataset.nudge === "join") return openMe();
    if (t.dataset.nudge === "checkin") return $("checkin").click();
    nudgeClosed = $("nudge").dataset.kind;
    renderNudge();
  });

  $("checkin").addEventListener("click", async () => {
    if (!session) { auth.afterLogin = "checkin"; return openMe(); }
    const mine = myCheckin();
    if (mine && mine.office === state.office) {
      if (await checkOut(session.id)) toast("출석을 취소했어요.");
      return;
    }
    if (await checkIn(session.id)) toast(`오늘 ${officeShort(state.office)}에서 먹는 걸로 체크했어요. 🙋`);
  });

  $("hide-disliked").addEventListener("change", (e) => {
    state.hideDisliked = e.target.checked;
    saveSettings();
    render();
  });

  $("migrate").addEventListener("click", (e) => {
    if (e.target.closest("[data-migrate]")) migrateLocal();
    if (e.target.closest("[data-migrate-skip]")) { writeJson(LOCAL_STORE_KEY, {}); render(); }
  });

  $("me-button").addEventListener("click", () => openMe());

  $("me-panel").addEventListener("click", async (e) => {
    if (e.target === $("me-panel")) return closeMe();
    const t = e.target.closest("button");
    if (!t) return;
    if ("closeMe" in t.dataset) return closeMe();
    if ("request" in t.dataset) { closeMe(); return openStats(true); }
    if ("back" in t.dataset) { auth.step = "login"; auth.pending = ""; auth.msg = ""; return renderMe(); }
    if ("logout" in t.dataset) {
      session = null;
      writeJson(SESSION_KEY, null);
      auth.step = "login";
      auth.msg = "";
      toast("로그아웃했어요.");
      render();
      return renderMe();
    }
    if (t.dataset.allergy) {
      const a = t.dataset.allergy, set = auth.draft.allergies;
      set.has(a) ? set.delete(a) : set.add(a);
      t.outerHTML = allergyChip(a, set.has(a)); // 스크롤 유지
      return;
    }
    if (t.dataset.cycle) {
      const tag = t.dataset.cycle, d = auth.draft;
      if (d.likes.has(tag)) { d.likes.delete(tag); d.dislikes.add(tag); }
      else if (d.dislikes.has(tag)) d.dislikes.delete(tag);
      else d.likes.add(tag);
      // 창 전체를 다시 그리면 스크롤이 맨 위로 가므로, 누른 버튼만 바꿈
      const cls = d.likes.has(tag) ? "up" : d.dislikes.has(tag) ? "down" : "";
      t.classList.remove("up", "down");
      if (cls) t.classList.add(cls);
      t.setAttribute("aria-pressed", String(!!cls));
      t.textContent = `${cls === "up" ? "👍 " : cls === "down" ? "👎 " : ""}${t.dataset.label}`;
      return;
    }
    if ("saveMe" in t.dataset && session) {
      auth.busy = true; renderMe();
      const office = $("me-office") ? $("me-office").value : null;
      const result = await savePrefsAuthed(session.id, session.secret, [...auth.draft.likes], [...auth.draft.dislikes], false, office, [...auth.draft.allergies]);
      auth.busy = false;
      if (result === "ok") {
        toast("내 취향을 저장했어요. 모두의 추천에 바로 반영돼요.");
        auth.open = false;
        render();
        return renderMe();
      }
      if (result === "wrong" || result === "new" || result === "invalid") {
        // 관리자가 비밀번호를 초기화했거나 바뀐 경우
        session = null;
        writeJson(SESSION_KEY, null);
        auth.step = "login";
        auth.msg = "로그인이 풀렸어요. 다시 로그인해 주세요.";
        render();
        return renderMe();
      }
      auth.msg = AUTH_MESSAGES[result] || AUTH_MESSAGES.error;
      renderMe();
    }
  });

  $("me-panel").addEventListener("change", (e) => {
    if (e.target.id === "me-office" || e.target.id === "signup-office") auth.office = e.target.value;
  });

  function afterStep() {
    renderMe();
    const next = $("me-body").querySelector("#confirm-secret, input");
    if (next) next.focus();
  }

  $("me-panel").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (auth.busy) return;

    if (e.target.id === "login-form") {
      const name = $("login-name").value.trim();
      const secret = normSecret($("login-secret").value);
      if (!name || !secret) return;
      auth.name = name;
      auth.msg = "";
      const person = findPersonByName(name);
      if (!person) {
        // 처음 온 사람 → 가입 단계
        auth.pending = secret;
        auth.step = "signup";
        return afterStep();
      }
      auth.pickId = person.id;
      auth.busy = true; renderMe();
      const result = await checkSecret(person.id, secret);
      auth.busy = false;
      if (result === "ok") {
        startSession(person.id, secret);
        toast(`${person.name}님, 반가워요!`);
        render();
      } else if (result === "new") {
        auth.pending = secret;
        auth.step = "reset";
      } else {
        auth.msg = AUTH_MESSAGES[result] || AUTH_MESSAGES.error;
      }
      return afterStep();
    }

    const again = normSecret($("confirm-secret").value);
    if (again !== auth.pending) {
      auth.msg = "처음 입력한 음식과 달라요. 다시 입력해 주세요.";
      return renderMe();
    }

    if (e.target.id === "signup-form") {
      const office = $("signup-office").value;
      auth.office = office;
      auth.busy = true; renderMe();
      const result = await registerPerson(auth.name, office, again);
      auth.busy = false;
      if (/^u[0-9a-f]{12}$/.test(result)) {
        startSession(result, again, true);
        toast(`가입했어요, ${auth.name}님! 이제 좋아하는 음식과 싫어하는 음식을 골라 주세요.`);
        render();
      } else {
        auth.msg = AUTH_MESSAGES[result] || AUTH_MESSAGES.error;
        if (result === "taken") auth.step = "login";
      }
      return renderMe();
    }

    if (e.target.id === "reset-form") {
      const { likes, dislikes } = prefsOf(personById(auth.pickId));
      auth.busy = true; renderMe();
      const result = await savePrefsAuthed(auth.pickId, again, likes, dislikes, true);
      auth.busy = false;
      if (result === "ok") {
        startSession(auth.pickId, again);
        toast("새 비밀번호로 정했어요.");
        render();
      } else {
        auth.msg = AUTH_MESSAGES[result] || AUTH_MESSAGES.error;
      }
      return renderMe();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && auth.open) closeMe();
  });

  $("pick").addEventListener("click", openRoulette);
  $("roulette-again").addEventListener("click", spin);
  $("roulette-close").addEventListener("click", closeRoulette);
  $("roulette-eat").addEventListener("click", async () => {
    const r = state.roulette;
    if (!r || !r.choice) return;
    const day = todayDoc();
    if (!(day && day.menu === r.choice.name)) {
      const ok = await updateToday({ menu: r.choice.name, shop: null, rating: null });
      if (!ok) return;
    }
    toast(`오늘 ${r.choice.name} 먹은 걸로 기록했어요.`);
    closeRoulette();
  });
  $("roulette").addEventListener("click", (e) => {
    if (e.target === $("roulette") && !(state.roulette && state.roulette.spinning)) closeRoulette();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.roulette && !state.roulette.spinning) closeRoulette();
  });

  render();
  connectStore();
  loadWeather(state.office);
})();
