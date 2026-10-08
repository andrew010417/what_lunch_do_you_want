(() => {
  const AVATAR_COLORS = [
    "#f59e0b", "#ef4444", "#10b981", "#3b82f6", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
  ];
  const WHEEL_COLORS = ["#c7d6ea", "#f6d7a7", "#cfe8d5", "#f3c9c9", "#ddd3f0", "#bfe3e6"];
  const SELECTION_KEY = "bionexus-lunch-selection-v2";
  const SETTINGS_KEY = "bionexus-lunch-settings";
  const LOCAL_STORE_KEY = "bionexus-lunch-local-store";
  const MAX_WHEEL = 12;

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
  const savedSelection = readJson(SELECTION_KEY, null);
  const state = {
    office: "gangnam",
    selected: new Set(savedSelection && savedSelection.date === todayKey() ? savedSelection.ids : []),
    hideDisliked: !!settings.hideDisliked,
    mood: settings.moodDate === todayKey() && MOODS[settings.mood] ? settings.mood : "any",
    lastClicked: null,
    editing: null,        // 취향 수정 중인 사람 id
    draft: null,          // { likes: Set, dislikes: Set }
    openShops: new Set(), // 가게 목록을 펼친 메뉴 이름
    confirmDelete: null,  // 삭제 확인 대기 중인 가게 id
    autoWeather: null,    // null: 불러오는 중, "failed", 또는 { kind, temp, rainy }
    roulette: null,
  };

  function saveSelection() {
    writeJson(SELECTION_KEY, { date: todayKey(), ids: [...state.selected] });
  }
  function saveSettings() {
    writeJson(SETTINGS_KEY, { hideDisliked: state.hideDisliked, mood: state.mood, moodDate: todayKey() });
  }

  // =================================================================
  // 저장소: claude.ai 링크에서는 모두가 공유하는 db, 그 외에는 이 브라우저
  // =================================================================
  const store = { mode: "connecting", prefs: {}, days: {}, restaurants: {} };
  const COLLECTIONS = ["prefs", "days", "restaurants"];
  let db = null;

  function useLocalStore() {
    const saved = readJson(LOCAL_STORE_KEY, {});
    COLLECTIONS.forEach((c) => { store[c] = saved[c] && typeof saved[c] === "object" ? saved[c] : {}; });
    store.mode = "local";
    render();
  }

  async function connectStore() {
    try {
      db = window.claude && typeof window.claude.use === "function" ? await window.claude.use("db") : null;
    } catch (_) {
      db = null;
    }
    if (!db) return useLocalStore();

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
      writeJson(LOCAL_STORE_KEY, { prefs: store.prefs, days: store.days, restaurants: store.restaurants });
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

  // 페이지에서 수정한 취향이 있으면 그것을, 없으면 data.js 기본값
  function prefsOf(p) {
    const saved = store.prefs[p.id];
    const likes = saved && strList(saved.likes);
    const dislikes = saved && strList(saved.dislikes);
    return likes && dislikes ? { likes, dislikes, edited: true } : { likes: p.likes, dislikes: p.dislikes, edited: false };
  }

  const officePeople = () => OFFICES[state.office].people;
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

  // =================================================================
  // 날씨
  // =================================================================
  async function loadWeather() {
    const loc = OFFICES.gangnam.location;
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
      state.autoWeather = { kind, temp, rainy };
    } catch (_) {
      state.autoWeather = "failed";
    } finally {
      clearTimeout(timer);
    }
    render();
  }

  function currentWeather() {
    const day = todayDoc();
    if (day && WEATHERS[day.weather]) return { kind: day.weather, source: "manual" };
    if (state.autoWeather && state.autoWeather !== "failed") return { kind: state.autoWeather.kind, source: "auto" };
    return { kind: "normal", source: "none" };
  }

  // =================================================================
  // 점수
  // =================================================================
  function scoreMenus() {
    const people = officePeople().filter((p) => state.selected.has(p.id));
    const weather = WEATHERS[currentWeather().kind];
    const mood = MOODS[state.mood];
    const recent = recentEaten();

    return MENUS.map((menu, index) => {
      const ups = [];
      const downs = [];
      const extras = [];
      for (const p of people) {
        const { likes, dislikes } = prefsOf(p);
        const liked = likes.filter((t) => menu.tags.includes(t));
        const disliked = dislikes.filter((t) => menu.tags.includes(t));
        if (liked.length) ups.push({ who: p.name, tags: liked });
        if (disliked.length) downs.push({ who: p.name, tags: disliked });
      }
      if (weather.boost && menu.tags.includes(weather.boost)) extras.push({ text: weather.reason, delta: 1 });
      if (mood.tag && menu.tags.includes(mood.tag)) extras.push({ text: mood.label, delta: 1 });
      if (recent.has(menu.name)) extras.push({ text: `🕒 ${recent.get(menu.name)}일 전에 먹음`, delta: -1 });

      // 좋아하는 사람 1명당 +1, 싫어하는 사람 1명당 -1, 날씨·기분 +1, 최근 먹음 -1
      const score = ups.length - downs.length + extras.reduce((s, x) => s + x.delta, 0);
      return { ...menu, index, score, ups, downs, extras };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
  }

  // 숨기기 모드면 한 명이라도 싫어하는 메뉴 제외
  function visibleMenus() {
    const ranked = scoreMenus();
    return state.hideDisliked ? ranked.filter((m) => m.downs.length === 0) : ranked;
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

  function renderSync() {
    const el = $("sync");
    el.dataset.mode = store.mode;
    el.textContent = store.mode === "shared" ? "● 모두와 실시간 공유 중"
      : store.mode === "local" ? "이 브라우저에만 저장돼요" : "연결 중…";
  }

  function renderPeople() {
    const people = officePeople();
    $("people").innerHTML = people.map((p, i) => `
      <button class="person${p.special ? " special" : ""}" data-id="${p.id}" aria-pressed="${state.selected.has(p.id)}">
        <span class="check">✓</span>
        ${p.special ? specialAvatarSvg() : avatarSvg(AVATAR_COLORS[i % AVATAR_COLORS.length])}
        <span class="name">${p.name}님</span>
      </button>`).join("");

    const names = people.filter((p) => state.selected.has(p.id)).map((p) => p.name + "님");
    $("selection-summary").textContent = names.length === 0
      ? "아무도 선택하지 않으면 모든 메뉴를 기본 순서로 보여줍니다."
      : `오늘 ${names.length}명: ${names.join(", ")}`;
  }

  function allTags() {
    const set = new Set();
    MENUS.forEach((m) => m.tags.forEach((t) => set.add(t)));
    return [...set];
  }

  const menusFor = (tags) => MENUS.filter((m) => tags.some((t) => m.tags.includes(t))).map((m) => m.name);

  // 가장 최근에 누른 사람의 취향 카드 (+ 취향 수정)
  function renderFocus() {
    const box = $("focus");
    const p = officePeople().find((x) => x.id === state.lastClicked);
    box.hidden = !p;
    if (!p) return;

    const on = state.selected.has(p.id);
    const head = `
      <div class="focus-head">
        <strong>${p.name}님</strong>
        <span class="focus-state ${on ? "on" : ""}">${on ? "오늘 출근 ✓" : "선택 해제됨"}</span>
        ${state.editing === p.id ? "" : `<button class="ghost small" data-edit="${p.id}">✏️ 취향 수정</button>`}
      </div>`;

    if (state.editing === p.id) {
      const d = state.draft;
      const chips = allTags().map((t) => {
        const cls = d.likes.has(t) ? "up" : d.dislikes.has(t) ? "down" : "";
        const mark = cls === "up" ? "👍 " : cls === "down" ? "👎 " : "";
        return `<button class="chip tap ${cls}" data-cycle="${esc(t)}" aria-pressed="${!!cls}">${mark}#${esc(t)}</button>`;
      }).join("");
      box.innerHTML = `${head}
        <p class="hint tight">태그를 한 번 누르면 👍 좋아함, 두 번 누르면 👎 싫어함, 세 번 누르면 해제돼요.</p>
        <div class="chips">${chips}</div>
        <div class="actions">
          <button class="primary" data-save-prefs="${p.id}">저장</button>
          <button class="ghost" data-cancel-edit>취소</button>
        </div>`;
      return;
    }

    const { likes, dislikes } = prefsOf(p);
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
      ${row("👎 싫어하는 음식", dislikes, "down")}`;
  }

  function renderConditions() {
    const w = currentWeather();
    const day = todayDoc();
    $("weather-chips").innerHTML = Object.entries(WEATHERS).map(([k, v]) =>
      `<button class="chip tap ${w.kind === k ? "active" : ""}" data-weather="${k}" aria-pressed="${w.kind === k}">${v.label}</button>`
    ).join("");

    const auto = state.autoWeather;
    let note;
    if (w.source === "manual") {
      note = "직접 고른 날씨가 모두에게 적용 중이에요. 같은 버튼을 다시 누르면 자동으로 돌아가요.";
    } else if (auto === null) {
      note = "강남 날씨를 불러오는 중…";
    } else if (auto === "failed") {
      note = "날씨를 자동으로 불러오지 못했어요. 오늘 날씨를 직접 골라 주세요.";
    } else {
      note = `자동: 강남 지금 ${auto.temp}°C, ${auto.rainy ? "비·눈 옴" : "비 안 옴"}`;
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

    const today = day && typeof day.menu === "string"
      ? `<div class="today-eaten">오늘: ${emojiOf(day.menu)} <strong>${esc(day.menu)}</strong> 먹음 <button class="ghost small" data-eat="${esc(day.menu)}">기록 취소</button></div>`
      : `<p class="hint tight">점심을 먹은 뒤 메뉴 옆 🍽 버튼을 누르면 기록돼요. 기록한 메뉴는 ${RECENT_DAYS}일 동안 순위가 1점 내려가요.</p>`;
    const list = past.length
      ? `<div class="chips">${past.map((d) => {
          const [, m, dd] = d.date.split("-");
          return `<span class="chip">${Number(m)}/${Number(dd)} ${emojiOf(d.menu)} ${esc(d.menu)} <small>(${d.ago}일 전)</small></span>`;
        }).join("")}</div>`
      : `<p class="hint tight">최근 ${RECENT_DAYS}일 동안 기록이 없어요.</p>`;
    $("history").innerHTML = today + list;
  }

  function shopsOf(menuName) {
    return Object.entries(store.restaurants)
      .map(([id, r]) => ({ id, ...r }))
      .filter((r) => r.office === state.office && r.menu === menuName && typeof r.name === "string")
      .sort((a, b) => (Number(a.walk) || 99) - (Number(b.walk) || 99));
  }

  function renderShops(m) {
    const shops = shopsOf(m.name);
    const area = OFFICES[state.office].area || "";
    const query = `${area} ${m.name.split(/[·(]/)[0]}`.trim();
    const items = shops.length
      ? `<ul class="shop-list">${shops.map((r) => {
          const meta = [
            Number(r.walk) > 0 ? `도보 ${Number(r.walk)}분` : "",
            Number(r.price) > 0 ? `${Number(r.price).toLocaleString("ko-KR")}원` : "",
          ].filter(Boolean).join(" · ");
          const confirming = state.confirmDelete === r.id;
          return `<li>
            <a href="https://map.naver.com/p/search/${encodeURIComponent(area + " " + r.name)}" target="_blank" rel="noopener">${esc(r.name)}</a>
            ${meta ? `<span class="shop-meta">${meta}</span>` : ""}
            <button class="ghost small ${confirming ? "danger" : ""}" data-del-shop="${esc(r.id)}">${confirming ? "정말 삭제?" : "삭제"}</button>
          </li>`;
        }).join("")}</ul>`
      : `<p class="hint tight">아직 등록된 가게가 없어요. 자주 가는 곳을 추가해 주세요.</p>`;
    return `
      <div class="shops">
        ${items}
        <form class="shop-form" data-add-shop="${m.index}">
          <input id="shop-name-${m.index}" name="name" placeholder="가게 이름" maxlength="40" required />
          <input id="shop-walk-${m.index}" name="walk" type="number" min="0" max="60" inputmode="numeric" placeholder="도보(분)" />
          <input id="shop-price-${m.index}" name="price" type="number" min="0" step="500" inputmode="numeric" placeholder="1인 가격(원)" />
          <button class="primary small" type="submit">추가</button>
        </form>
        <a class="map-link" href="https://map.naver.com/p/search/${encodeURIComponent(query)}" target="_blank" rel="noopener">네이버 지도에서 '${esc(query)}' 찾기 ↗</a>
      </div>`;
  }

  function renderMenus() {
    // 다른 사람이 저장해서 다시 그려져도 입력 중인 글자는 유지
    const active = document.activeElement && document.activeElement.id;
    const typed = {};
    $("menus").querySelectorAll("input[id]").forEach((el) => { typed[el.id] = el.value; });

    const all = scoreMenus();
    const ranked = visibleMenus();
    const hidden = all.filter((m) => m.downs.length);
    $("hidden-summary").hidden = !state.hideDisliked;
    $("hidden-summary").textContent = hidden.length
      ? `누군가 싫어하는 메뉴 ${hidden.length}개를 숨겼어요: ${hidden.map((m) => m.name).join(", ")}`
      : "숨긴 메뉴가 없어요. 체크한 사람 중 아무도 싫어하는 메뉴가 없습니다.";

    const eatenToday = (todayDoc() || {}).menu;
    const fmt = (list) => list.map((r) => `${r.who}님(${r.tags.join(", ")})`).join(", ");

    $("menus").innerHTML = ranked.map((m, i) => {
      const cls = m.score > 0 ? "good" : m.score < 0 ? "bad" : "";
      const badge = m.score > 0 ? `추천 +${m.score}` : m.score < 0 ? `비추 ${m.score}` : "";
      const reasons = [
        m.ups.length ? `<div class="up">👍 ${fmt(m.ups)}</div>` : "",
        m.downs.length ? `<div class="down">👎 ${fmt(m.downs)}</div>` : "",
        ...m.extras.map((x) => `<div class="${x.delta > 0 ? "up" : "down"}">${x.text} ${x.delta > 0 ? "+1" : "-1"}</div>`),
      ].join("");
      const shopCount = shopsOf(m.name).length;
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
              <button class="ghost small" data-shops="${esc(m.name)}" aria-expanded="${open}">🏪 근처 가게 ${shopCount} ${open ? "▴" : "▾"}</button>
            </div>
          </div>
          ${badge ? `<span class="badge">${badge}</span>` : "<span></span>"}
          ${open ? renderShops(m) : ""}
        </li>`;
    }).join("");

    Object.entries(typed).forEach(([id, v]) => { const el = $(id); if (el) el.value = v; });
    if (active && $(active)) $(active).focus();
  }

  function render() {
    renderTabs();
    renderSync();
    const office = OFFICES[state.office];
    const ready = office.people.length > 0;
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
    const ranked = visibleMenus();
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
  });

  $("people").addEventListener("click", (e) => {
    const btn = e.target.closest(".person");
    if (!btn) return;
    const id = btn.dataset.id;
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    if (state.lastClicked !== id) { state.editing = null; state.draft = null; }
    state.lastClicked = id;
    saveSelection();
    render();
  });

  $("focus").addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.edit) {
      const p = officePeople().find((x) => x.id === t.dataset.edit);
      const { likes, dislikes } = prefsOf(p);
      state.editing = p.id;
      state.draft = { likes: new Set(likes), dislikes: new Set(dislikes) };
    } else if (t.dataset.cycle) {
      const tag = t.dataset.cycle;
      const d = state.draft;
      if (d.likes.has(tag)) { d.likes.delete(tag); d.dislikes.add(tag); }
      else if (d.dislikes.has(tag)) d.dislikes.delete(tag);
      else d.likes.add(tag);
    } else if (t.dataset.savePrefs) {
      const id = t.dataset.savePrefs;
      const ok = await write("prefs", id, { likes: [...state.draft.likes], dislikes: [...state.draft.dislikes] });
      if (!ok) return;
      state.editing = null;
      state.draft = null;
      toast("취향을 저장했어요.");
    } else if ("cancelEdit" in t.dataset) {
      state.editing = null;
      state.draft = null;
    } else {
      return;
    }
    render();
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
    const ok = await updateToday({ menu: undo ? null : name });
    if (ok) toast(undo ? "오늘 기록을 지웠어요." : `오늘 ${name} 먹은 걸로 기록했어요.`);
  }

  $("history").addEventListener("click", (e) => {
    const t = e.target.closest("[data-eat]");
    if (t) toggleEaten(t.dataset.eat);
  });

  $("menus").addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.eat) return toggleEaten(t.dataset.eat);
    if (t.dataset.shops) {
      const name = t.dataset.shops;
      state.openShops.has(name) ? state.openShops.delete(name) : state.openShops.add(name);
      return render();
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
    const form = e.target.closest("[data-add-shop]");
    if (!form) return;
    e.preventDefault();
    const menu = MENUS[Number(form.dataset.addShop)];
    const fd = new FormData(form);
    const name = String(fd.get("name") || "").trim();
    if (!name) return;
    const id = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ok = await write("restaurants", id, {
      office: state.office,
      menu: menu.name,
      name,
      walk: Math.max(0, Number(fd.get("walk")) || 0),
      price: Math.max(0, Number(fd.get("price")) || 0),
    });
    if (ok) {
      ["name", "walk", "price"].forEach((f) => { const el = $(`shop-${f}-${form.dataset.addShop}`); if (el) el.value = ""; });
      toast(`${menu.name}에 '${name}'을(를) 추가했어요.`);
    }
  });

  $("select-all").addEventListener("click", () => {
    officePeople().forEach((p) => state.selected.add(p.id));
    saveSelection();
    render();
  });

  $("clear-all").addEventListener("click", () => {
    state.selected.clear();
    state.lastClicked = null;
    state.editing = null;
    state.draft = null;
    saveSelection();
    render();
  });

  $("hide-disliked").addEventListener("change", (e) => {
    state.hideDisliked = e.target.checked;
    saveSettings();
    render();
  });

  $("pick").addEventListener("click", openRoulette);
  $("roulette-again").addEventListener("click", spin);
  $("roulette-close").addEventListener("click", closeRoulette);
  $("roulette-eat").addEventListener("click", async () => {
    const r = state.roulette;
    if (!r || !r.choice) return;
    const day = todayDoc();
    if (!(day && day.menu === r.choice.name)) {
      const ok = await updateToday({ menu: r.choice.name });
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
  loadWeather();
})();
