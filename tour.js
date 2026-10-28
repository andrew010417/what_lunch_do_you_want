// =====================================================================
// 맛집 탐방 지도: 링크 속 가게를 지도에 표시하고 각자 별점을 매김
// - 기록은 점심 고르기와 같은 Supabase 표(lunch_docs)에 저장
//   restaurants: id "tour_…" (office: "tour" 라 점심 고르기 가게 목록에는 안 보임)
//   ratings: 점심 고르기와 같은 형식이라, 같은 가게면 별점이 같이 보임
// - 로그인도 점심 고르기와 같음 (이름 + 제일 좋아하는 음식)
// =====================================================================
(() => {
  // 처음 받은 링크. 가게 이름은 처음 연 사람이 한 번 입력하면 모두에게 저장됨
  const PRESET = [
    { id: "tour_1", link: "https://naver.me/FhfQ2qZV", title: "네이버 지도 링크 1" },
    { id: "tour_2", link: "https://naver.me/Ge7MElh4", title: "네이버 지도 링크 2" },
    { id: "tour_3", link: "https://blog.naver.com/ho_ooon/224446248821", title: "하이드 온 스팟 (블로그)" },
    { id: "tour_4", link: "https://blog.naver.com/rnbthug/224370527091", title: "건방진생선까스 Me,Myself & I (블로그)" },
    { id: "tour_5", link: "https://blog.naver.com/swannnzy/224383397593", title: "1시간 전 (블로그)" },
    { id: "tour_6", link: "https://blog.naver.com/ashley700/224419818147", title: "챙 라이프 (블로그)" },
    { id: "tour_7", link: "https://blog.naver.com/tkdzmaaldald/224347521749", title: "횸의 일상기록 (블로그)" },
    { id: "tour_8", link: "https://blog.naver.com/sungjoonman/224374006977", title: "용헬남 (블로그)" },
  ];
  const BASE_OFFICE = "gangnam";         // 거리 계산·가게 검색 기준 사무실
  const SEARCH_RADIUS = 20000;           // 가게 이름으로 찾을 범위(m)
  const WALK_METERS_PER_MIN = 67;
  const SESSION_KEY = "bionexus-lunch-session";
  const TABLE = "lunch_docs";
  const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (typeof u === "string" && /^https?:\/\/[^\s"<>]+$/i.test(u) ? u : null);
  const isKakaoPlaceUrl = (u) => typeof u === "string" && /^https?:\/\/place\.map\.kakao\.com\/\d+$/.test(u);
  const readJson = (k, f) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? f : v; } catch (e) { return f; } };
  const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 안 돼도 동작 */ } };

  const store = { people: {}, prefs: {}, restaurants: {}, ratings: {} };
  const state = { sort: "no", selected: null, editing: null, candidates: {}, searching: null, conn: "connecting" };
  let sb = null;
  let session = readJson(SESSION_KEY, null);
  if (!session || typeof session.id !== "string" || typeof session.secret !== "string") session = null;

  // ------------------------------------------------------------------
  // 저장소
  // ------------------------------------------------------------------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      const timer = setTimeout(() => reject(new Error("timeout")), 10000);
      s.src = src;
      s.onload = () => { clearTimeout(timer); resolve(); };
      s.onerror = () => { clearTimeout(timer); reject(new Error("load")); };
      document.head.appendChild(s);
    });
  }

  async function refresh() {
    const { data, error } = await sb.from(TABLE).select("collection,id,data").limit(10000);
    if (error) throw error;
    Object.keys(store).forEach((c) => { store[c] = {}; });
    (data || []).forEach((row) => {
      if (store[row.collection] && row.data && typeof row.data === "object") store[row.collection][row.id] = row.data;
    });
  }

  async function connect() {
    try {
      if (!(window.supabase && window.supabase.createClient)) await loadScript(SDK);
      const url = SUPABASE_URL.trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
      sb = window.supabase.createClient(url, SUPABASE_ANON_KEY.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
      await refresh();
      state.conn = "ok";
      sb.channel("tour-docs")
        .on("postgres_changes", { event: "*", schema: "public", table: TABLE }, (payload) => {
          const removed = payload.eventType === "DELETE";
          const row = removed ? payload.old : payload.new;
          if (!row || !store[row.collection] || typeof row.id !== "string") return;
          if (removed) delete store[row.collection][row.id];
          else if (row.data && typeof row.data === "object") store[row.collection][row.id] = row.data;
          render();
        })
        .subscribe();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refresh().then(render).catch(() => {});
      });
    } catch (e) {
      console.warn("Supabase 연결 실패", e);
      state.conn = "fail";
    }
    render();
  }

  async function write(collection, id, data) {
    if (state.conn !== "ok") { toast("공유 저장소에 연결되지 않아 저장할 수 없어요."); return false; }
    const { error } = data
      ? await sb.from(TABLE).upsert({ collection, id, data, updated_at: new Date().toISOString() })
      : await sb.from(TABLE).delete().match({ collection, id });
    if (error) {
      console.warn("저장 실패", error);
      toast("저장하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.");
      return false;
    }
    if (data) store[collection][id] = data; else delete store[collection][id];
    render();
    return true;
  }

  // ------------------------------------------------------------------
  // 가게 · 별점
  // ------------------------------------------------------------------
  const officeCoords = { ...OFFICES[BASE_OFFICE].location };
  function distanceM(a, b) {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return Math.round(6371000 * 2 * Math.asin(Math.sqrt(h)));
  }
  const fmtMeters = (m) => (m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`);
  const walkMinutes = (m) => Math.max(1, Math.round(m / WALK_METERS_PER_MIN));
  const hasCoords = (r) => typeof r.lat === "number" && typeof r.lon === "number" && Number.isFinite(r.lat) && Number.isFinite(r.lon);
  const validStars = (v) => typeof v === "number" && v >= 0.5 && v <= 5 && Math.round(v * 2) === v * 2;
  const ratingId = (key, personId) => `rt_${key}_${personId}`;
  const personName = (id) => (store.people[id] && typeof store.people[id].name === "string" ? store.people[id].name : "알 수 없음");

  // 별점 기준: 카카오 장소 id (점심 고르기와 같은 가게면 같은 별점)
  const shopKey = (s) => (isKakaoPlaceUrl(s.kakaoUrl) ? "k" + s.kakaoUrl.split("/").pop() : s.id);

  function places() {
    const saved = Object.entries(store.restaurants)
      .filter(([id, r]) => id.startsWith("tour_") && r && r.office === "tour")
      .map(([id, r]) => ({ id, ...r }));
    const byId = new Map(saved.map((s) => [s.id, s]));
    const list = [
      ...PRESET.filter((p) => !(byId.get(p.id) || {}).removed).map((p) => ({ ...p, ...(byId.get(p.id) || {}) })),
      ...saved.filter((s) => !PRESET.some((p) => p.id === s.id) && !s.removed)
        .sort((a, b) => String(a.added || "").localeCompare(String(b.added || ""))),
    ];
    return list.map((s, i) => {
      const linked = typeof s.name === "string" && s.name && hasCoords(s);
      const key = linked ? shopKey(s) : null;
      const ratings = key ? Object.entries(store.ratings)
        .filter(([, r]) => r && r.shop === key && validStars(r.stars))
        .map(([rid, r]) => ({ rid, ...r })) : [];
      const avg = ratings.length ? ratings.reduce((a, r) => a + r.stars, 0) / ratings.length : 0;
      const meters = linked ? distanceM(officeCoords, s) : null;
      return { ...s, no: i + 1, linked, key, ratings, avg, meters };
    });
  }

  function sorted(list) {
    const copy = [...list];
    if (state.sort === "rating") copy.sort((a, b) => b.avg - a.avg || b.ratings.length - a.ratings.length || a.no - b.no);
    if (state.sort === "near") copy.sort((a, b) => (a.meters ?? 1e9) - (b.meters ?? 1e9) || a.no - b.no);
    if (state.sort === "todo") copy.sort((a, b) => (a.ratings.length > 0) - (b.ratings.length > 0) || a.no - b.no);
    return copy;
  }

  // ------------------------------------------------------------------
  // 카카오맵
  // ------------------------------------------------------------------
  let kakaoPromise = null;
  let map = null;
  let overlays = [];
  let officeOverlay = null;

  function loadKakao() {
    if (kakaoPromise) return kakaoPromise;
    kakaoPromise = new Promise((resolve, reject) => {
      if (window.kakao && window.kakao.maps && window.kakao.maps.services) return resolve(window.kakao);
      const timer = setTimeout(() => reject(new Error("sdk")), 8000);
      const s = document.createElement("script");
      s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(KAKAO_JS_KEY)}&libraries=services&autoload=false`;
      s.onload = () => {
        try { window.kakao.maps.load(() => { clearTimeout(timer); resolve(window.kakao); }); }
        catch (e) { clearTimeout(timer); reject(new Error("sdk")); }
      };
      s.onerror = () => { clearTimeout(timer); reject(new Error("sdk")); };
      document.head.appendChild(s);
    }).catch((e) => { kakaoPromise = null; throw e; });
    return kakaoPromise;
  }

  async function initMap() {
    try {
      const kakao = await loadKakao();
      await new Promise((resolve) => {
        new kakao.maps.services.Geocoder().addressSearch(OFFICES[BASE_OFFICE].address, (res, status) => {
          if (status === kakao.maps.services.Status.OK && res[0]) {
            officeCoords.lat = Number(res[0].y);
            officeCoords.lon = Number(res[0].x);
          }
          resolve();
        });
      });
      $("map").innerHTML = "";
      map = new kakao.maps.Map($("map"), { center: new kakao.maps.LatLng(officeCoords.lat, officeCoords.lon), level: 5 });
      render();
      fitMap();
    } catch (e) {
      $("map-note").innerHTML = `카카오 지도를 불러오지 못했어요. <b>${esc(location.origin)}</b> 이 카카오 개발자 사이트에 등록된 주소인지 확인해 주세요.
        (claude.ai 링크 안에서는 지도가 안 떠요. 목록과 별점은 그대로 쓸 수 있어요.)`;
    }
  }

  function drawPins(list) {
    const kakao = window.kakao;
    if (!map || !kakao) return;
    overlays.forEach((o) => o.setMap(null));
    overlays = [];
    if (!officeOverlay) {
      officeOverlay = new kakao.maps.CustomOverlay({
        map, position: new kakao.maps.LatLng(officeCoords.lat, officeCoords.lon),
        content: `<div class="pin office">🏢 ${esc(OFFICES[BASE_OFFICE].label.replace("편", ""))} 사무실</div>`, yAnchor: 1.2, zIndex: 2,
      });
    }
    list.filter((s) => s.linked).forEach((s) => {
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = `pin tour-pin${s.ratings.length ? " visited" : ""}${state.selected === s.id ? " selected" : ""}`;
      pin.textContent = String(s.no);
      pin.setAttribute("aria-label", `${s.no}번 ${s.name}`);
      const tip = document.createElement("span");
      tip.className = "pin-tip";
      tip.textContent = `${s.name}${s.ratings.length ? ` · ★${s.avg.toFixed(1)}` : " · 아직 안 가봄"}`;
      pin.appendChild(tip);
      const overlay = new kakao.maps.CustomOverlay({ map, position: new kakao.maps.LatLng(s.lat, s.lon), content: pin, yAnchor: 1.1, zIndex: state.selected === s.id ? 5 : 1 });
      pin.addEventListener("mouseenter", () => overlay.setZIndex(10));
      pin.addEventListener("mouseleave", () => overlay.setZIndex(state.selected === s.id ? 5 : 1));
      pin.addEventListener("click", () => select(s.id, false));
      overlays.push(overlay);
    });
  }

  function fitMap() {
    const kakao = window.kakao;
    if (!map || !kakao) return;
    const pts = places().filter((s) => s.linked);
    if (!pts.length) return;
    const bounds = new kakao.maps.LatLngBounds();
    bounds.extend(new kakao.maps.LatLng(officeCoords.lat, officeCoords.lon));
    pts.forEach((s) => bounds.extend(new kakao.maps.LatLng(s.lat, s.lon)));
    map.setBounds(bounds);
  }

  // 가게 이름 → 카카오맵 후보 (사무실에서 가까운 곳 위주로 정확도순)
  async function searchPlaces(id, query) {
    state.searching = id;
    state.candidates[id] = null;
    render();
    try {
      const kakao = await loadKakao();
      const S = kakao.maps.services;
      const found = await new Promise((resolve, reject) => {
        new S.Places().keywordSearch(query, (data, status) => {
          if (status === S.Status.OK) resolve(data);
          else if (status === S.Status.ZERO_RESULT) resolve([]);
          else reject(new Error("search"));
        }, { location: new kakao.maps.LatLng(officeCoords.lat, officeCoords.lon), radius: SEARCH_RADIUS, sort: S.SortBy.ACCURACY, size: 6 });
      });
      state.candidates[id] = found.map((p) => ({
        name: p.place_name,
        address: p.road_address_name || p.address_name || "",
        category: (p.category_name || "").split(" > ").pop(),
        lat: Number(p.y), lon: Number(p.x),
        kakaoUrl: isKakaoPlaceUrl(p.place_url) ? p.place_url : "",
      })).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
    } catch (e) {
      state.candidates[id] = "error";
    }
    state.searching = null;
    render();
  }

  // ------------------------------------------------------------------
  // 화면
  // ------------------------------------------------------------------
  function starsHtml(value, interactive) {
    return [1, 2, 3, 4, 5].map((n) => {
      const cls = value >= n ? "s-full" : value >= n - 0.5 ? "s-half" : "s-empty";
      const halves = interactive
        ? `<button type="button" class="star-half left" data-stars="${n - 0.5}" aria-label="${n - 0.5}점"></button><button type="button" class="star-half right" data-stars="${n}" aria-label="${n}점"></button>`
        : "";
      return `<span class="star ${cls}" aria-hidden="${interactive ? "false" : "true"}">${halves}</span>`;
    }).join("");
  }

  function ratingBlock(s) {
    const mine = session && store.ratings[ratingId(s.key, session.id)];
    const my = mine && validStars(mine.stars) ? mine.stars : 0;
    const picker = session
      ? `<div class="tour-rate">
          <span class="tour-rate-label">내 별점</span>
          <span class="stars" data-rate="${esc(s.id)}" role="group" aria-label="${esc(s.name)} 별점, 0.5점 단위">${starsHtml(my, true)}</span>
          <span class="star-value">${my ? my.toFixed(1) : ""}</span>
        </div>
        ${my ? `<form class="tour-note" data-note="${esc(s.id)}">
          <input name="note" maxlength="60" placeholder="한줄평 (선택, 예: 국물이 진해요)" value="${esc((mine && mine.note) || "")}" />
          <button class="ghost small" type="submit">저장</button>
        </form>` : `<p class="hint tight">가 보셨으면 별을 눌러 주세요. 별 왼쪽 반은 0.5점이에요. 같은 점수를 다시 누르면 지워져요.</p>`}`
      : `<button type="button" class="link-button" data-login>로그인하고 별점 주기</button>`;
    const others = s.ratings
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
      .map((r) => `<li><b>${esc(personName(r.person))}</b> <span class="stars tiny">${starsHtml(r.stars, false)}</span> ${r.stars.toFixed(1)}${
        typeof r.note === "string" && r.note ? ` · “${esc(r.note)}”` : ""}</li>`).join("");
    return `${picker}${others ? `<ul class="tour-reviews">${others}</ul>` : ""}`;
  }

  function linksHtml(s) {
    const link = safeUrl(s.link);
    return `<div class="tour-links">
      ${link ? `<a class="primary small" href="${esc(link)}" target="_blank" rel="noopener">📖 후기·링크 보기 ↗</a>` : ""}
      ${s.linked && isKakaoPlaceUrl(s.kakaoUrl) ? `<a class="ghost small" href="${esc(s.kakaoUrl)}" target="_blank" rel="noopener">카카오맵 ↗</a>` : ""}
      ${s.linked ? `<a class="ghost small" href="https://map.kakao.com/link/to/${encodeURIComponent(s.name)},${s.lat},${s.lon}" target="_blank" rel="noopener">길찾기 ↗</a>` : ""}
    </div>`;
  }

  function linkForm(s) {
    const c = state.candidates[s.id];
    let found = "";
    if (state.searching === s.id) found = `<p class="hint tight">카카오맵에서 찾는 중…</p>`;
    else if (c === "error") found = `<p class="hint tight error">카카오맵 검색이 안 돼요. 잠시 후 다시 해 주세요.</p>`;
    else if (Array.isArray(c) && !c.length) found = `<p class="hint tight">찾는 가게가 없어요. 지점 이름까지 넣어 보세요. (예: ○○ 강남점)</p>`;
    else if (Array.isArray(c)) {
      found = `<ul class="tour-candidates">${c.map((p, i) => `
        <li><button type="button" class="ghost small" data-pick="${esc(s.id)}:${i}">이 가게예요</button>
          <span><b>${esc(p.name)}</b> <span class="shop-meta">${esc(p.category)} · ${esc(p.address)} · 사무실에서 ${fmtMeters(distanceM(officeCoords, p))}</span></span></li>`).join("")}</ul>`;
    }
    return `<form class="tour-link-form" data-search="${esc(s.id)}">
        <input name="q" maxlength="40" placeholder="링크 속 가게 이름 (예: ○○식당 강남점)" value="${esc(s.linked ? s.name : "")}" required />
        <button class="primary small" type="submit">카카오맵에서 찾기</button>
        ${s.linked ? `<button class="link-button" type="button" data-cancel>취소</button>` : ""}
      </form>${found}`;
  }

  function itemHtml(s) {
    const open = state.editing === s.id || !s.linked;
    const meta = s.linked
      ? [s.category, s.address, `📍 사무실에서 ${fmtMeters(s.meters)} · 도보 ${walkMinutes(s.meters)}분`].filter(Boolean).map(esc).join(" · ")
      : "";
    const badge = s.ratings.length
      ? `<span class="tour-badge done">★ ${s.avg.toFixed(1)} · ${s.ratings.length}명 가봄</span>`
      : `<span class="tour-badge">아직 안 가봄</span>`;
    return `<li class="tour-item${state.selected === s.id ? " selected" : ""}" id="item-${esc(s.id)}">
      <span class="pin-no ${s.ratings.length ? "visited" : ""}">${s.no}</span>
      <div class="tour-body">
        <div class="tour-title">
          ${s.linked ? `<button type="button" class="tour-name" data-select="${esc(s.id)}">${esc(s.name)}</button>` : `<span class="tour-name empty">가게 이름을 넣어 주세요</span>`}
          ${badge}
        </div>
        <div class="shop-meta">${esc(s.title || "")}${meta ? ` · ${meta}` : ""}</div>
        ${linksHtml(s)}
        ${open ? `<p class="hint tight">${s.linked ? "다른 가게로 바꾸기" : "링크를 열어 가게 이름을 확인하고 입력하면, 지도에 표시되고 모두에게 저장돼요."}</p>${linkForm(s)}` : ""}
        ${s.linked ? ratingBlock(s) : ""}
        <div class="tour-tools">
          ${s.linked && !open ? `<button type="button" class="link-button" data-edit="${esc(s.id)}">가게 바꾸기</button>` : ""}
          <button type="button" class="link-button" data-remove="${esc(s.id)}">${state.confirmRemove === s.id ? "정말 목록에서 뺄까요?" : "목록에서 빼기"}</button>
        </div>
      </div>
    </li>`;
  }

  function renderPopup(list) {
    const s = list.find((x) => x.id === state.selected && x.linked);
    $("popup").hidden = !s;
    if (!s) return;
    $("popup").innerHTML = `
      <div class="tour-title">
        <span class="pin-no ${s.ratings.length ? "visited" : ""}">${s.no}</span>
        <strong>${esc(s.name)}</strong>
        ${s.ratings.length ? `<span class="tour-badge done">★ ${s.avg.toFixed(1)} · ${s.ratings.length}명</span>` : `<span class="tour-badge">아직 안 가봄</span>`}
        <button type="button" class="link-button tour-close" data-close-popup aria-label="닫기">닫기 ✕</button>
      </div>
      <div class="shop-meta">${esc(s.category || "")} · 📍 사무실에서 ${fmtMeters(s.meters)} · 도보 ${walkMinutes(s.meters)}분</div>
      ${linksHtml(s)}
      ${ratingBlock(s)}`;
  }

  function renderProgress(list) {
    const linked = list.filter((s) => s.linked);
    const visited = list.filter((s) => s.ratings.length);
    const mine = session ? list.filter((s) => s.key && store.ratings[ratingId(s.key, session.id)]).length : 0;
    const pct = list.length ? Math.round((visited.length / list.length) * 100) : 0;
    const best = [...visited].sort((a, b) => b.avg - a.avg)[0];
    $("progress").innerHTML = `
      <div class="tour-stat"><b>${visited.length}</b> / ${list.length}곳 가봤어요 ${session ? `<span class="hint tight">(나는 ${mine}곳)</span>` : ""}</div>
      <div class="tour-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
      <div class="hint tight">${linked.length < list.length ? `가게 이름이 아직 없는 링크 ${list.length - linked.length}개 · ` : ""}${best ? `지금 1등: <b>${esc(best.name)}</b> ★${best.avg.toFixed(1)}` : "별점이 쌓이면 1등 가게가 여기 보여요"}</div>`;
  }

  function render() {
    const list = places();
    $("sync").textContent = { connecting: "연결 중…", ok: "● 모두와 실시간 공유 중", fail: "공유 저장소 연결 실패 · 새로고침해 주세요" }[state.conn];
    $("sync").dataset.mode = state.conn === "ok" ? "shared" : "";
    const me = session && store.people[session.id];
    $("me-button").textContent = me ? `👤 ${me.name}님` : "🔑 로그인";
    renderProgress(list);
    $("sort-chips").innerHTML = [["no", "번호순"], ["rating", "별점순"], ["near", "가까운 순"], ["todo", "안 가본 곳 먼저"]]
      .map(([k, label]) => `<button class="chip tap ${state.sort === k ? "active" : ""}" data-sort="${k}" aria-pressed="${state.sort === k}">${label}</button>`).join("");
    // 입력 중인 글자 유지
    const active = document.activeElement;
    const keep = active && active.closest && active.closest("form[data-search], form[data-note]");
    const keepSel = keep ? `form[data-${keep.dataset.search ? "search" : "note"}="${keep.dataset.search || keep.dataset.note}"] input` : null;
    const typed = keep ? active.value : null;
    $("list").innerHTML = sorted(list).map(itemHtml).join("");
    if (keepSel) { const el = document.querySelector(keepSel); if (el) { el.value = typed; el.focus(); } }
    renderPopup(list);
    drawPins(list);
    renderMe();
  }

  function select(id, scroll) {
    state.selected = id;
    render();
    const s = places().find((x) => x.id === id);
    if (map && window.kakao && s && s.linked) map.panTo(new window.kakao.maps.LatLng(s.lat, s.lon));
    if (scroll) $("map").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ------------------------------------------------------------------
  // 로그인 (점심 고르기와 같은 계정)
  // ------------------------------------------------------------------
  const auth = { open: false, msg: "", busy: false };
  function renderMe() {
    $("me-panel").hidden = !auth.open;
    if (!auth.open) return;
    const me = session && store.people[session.id];
    if (me) {
      $("me-body").innerHTML = `
        <h2 id="me-title">${esc(me.name)}님</h2>
        <p class="hint tight">취향·알레르기 수정과 가입은 <a href="./">점심 고르기</a>에서 해요.</p>
        <div class="me-actions">
          <button type="button" class="ghost" data-close-me>닫기</button>
          <button type="button" class="link-button" data-logout>로그아웃</button>
        </div>`;
      return;
    }
    $("me-body").innerHTML = `
      <h2 id="me-title">로그인</h2>
      <p class="hint tight">점심 고르기와 같은 계정이에요. 아직 가입 안 했으면 <a href="./">점심 고르기</a>에서 먼저 가입해 주세요.</p>
      <form class="me-form" id="login-form">
        <label class="me-field">이름
          <input id="login-name" maxlength="20" autocomplete="off" placeholder="예: 박재형" required />
        </label>
        <label class="me-field"><span>제일 좋아하는 음식 <span class="pw-tag">(비밀번호)</span></span>
          <input id="login-secret" type="password" autocomplete="off" maxlength="50" required />
        </label>
        ${auth.msg ? `<p class="hint tight error" role="alert">${auth.msg}</p>` : ""}
        <div class="me-actions">
          <button class="primary" type="submit" ${auth.busy ? "disabled" : ""}>로그인</button>
          <button type="button" class="ghost" data-close-me>닫기</button>
        </div>
      </form>`;
  }
  function openMe() {
    auth.open = true;
    auth.msg = "";
    renderMe();
    const f = $("me-body").querySelector("input, button");
    if (f) f.focus();
  }

  document.addEventListener("submit", async (e) => {
    if (e.target.id === "login-form") {
      e.preventDefault();
      const name = $("login-name").value.trim();
      const secret = $("login-secret").value.replace(/\s+/g, "").toLowerCase();
      const entry = Object.entries(store.people).find(([, p]) => p && typeof p.name === "string" && p.name.toLowerCase() === name.toLowerCase());
      if (!entry) { auth.msg = `'${esc(name)}'(으)로 가입한 분이 없어요. <a href="./">점심 고르기</a>에서 먼저 가입해 주세요.`; return renderMe(); }
      if (!sb) { auth.msg = "공유 저장소에 연결되지 않았어요."; return renderMe(); }
      auth.busy = true; renderMe();
      const { data, error } = await sb.rpc("lunch_check_secret", { p_person: entry[0], p_secret: secret });
      auth.busy = false;
      if (!error && data === "ok") {
        session = { id: entry[0], secret };
        writeJson(SESSION_KEY, session);
        auth.open = false;
        toast(`${entry[1].name}님, 반가워요! 이제 별점을 줄 수 있어요.`);
        return render();
      }
      auth.msg = error ? "연결에 실패했어요. 잠시 후 다시 해 주세요."
        : data === "locked" ? "5번 틀려서 10분 동안 잠겼어요."
        : data === "new" ? `비밀번호가 초기화됐어요. <a href="./">점심 고르기</a>에서 새로 정해 주세요.`
        : "좋아하는 음식이 맞지 않아요. 띄어쓰기는 상관없어요.";
      return renderMe();
    }

    const search = e.target.closest("[data-search]");
    if (search) {
      e.preventDefault();
      const q = String(new FormData(search).get("q") || "").trim();
      if (q) searchPlaces(search.dataset.search, q);
      return;
    }

    const note = e.target.closest("[data-note]");
    if (note && session) {
      e.preventDefault();
      const s = places().find((x) => x.id === note.dataset.note);
      const cur = s && store.ratings[ratingId(s.key, session.id)];
      if (!cur) return;
      const text = String(new FormData(note).get("note") || "").trim().slice(0, 60);
      if (await write("ratings", ratingId(s.key, session.id), { ...cur, note: text })) toast(text ? "한줄평을 저장했어요." : "한줄평을 지웠어요.");
      return;
    }

    if (e.target.id === "add-form") {
      e.preventDefault();
      const fd = new FormData(e.target);
      const link = safeUrl(String(fd.get("link") || "").trim());
      if (!link) return toast("https:// 로 시작하는 링크를 넣어 주세요.");
      const title = String(fd.get("title") || "").trim().slice(0, 40) || "추가한 링크";
      const id = "tour_x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (await write("restaurants", id, { office: "tour", link, title, added: new Date().toISOString(), by: session ? session.id : null })) {
        e.target.reset();
        toast("링크를 추가했어요. 아래에서 가게 이름을 넣어 주세요.");
        const el = $(`item-${id}`);
        if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); const input = el.querySelector("input"); if (input) input.focus(); }
      }
    }
  });

  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button, [data-close-me]");
    if (!t) {
      if (e.target === $("me-panel")) { auth.open = false; renderMe(); }
      return;
    }
    if (t.id === "me-button") return openMe();
    if ("closeMe" in t.dataset) { auth.open = false; return renderMe(); }
    if ("logout" in t.dataset) {
      session = null;
      writeJson(SESSION_KEY, null);
      auth.open = false;
      toast("로그아웃했어요.");
      return render();
    }
    if ("login" in t.dataset) return openMe();
    if (t.dataset.sort) { state.sort = t.dataset.sort; return render(); }
    if (t.dataset.select) return select(t.dataset.select, true);
    if ("closePopup" in t.dataset) { state.selected = null; return render(); }
    if (t.dataset.edit) { state.editing = t.dataset.edit; return render(); }
    if ("cancel" in t.dataset) { state.editing = null; return render(); }

    if (t.dataset.pick) {
      const [id, i] = t.dataset.pick.split(":");
      const c = (state.candidates[id] || [])[Number(i)];
      if (!c) return;
      const before = places().find((x) => x.id === id) || PRESET.find((p) => p.id === id) || {};
      const { no, linked, key, ratings, avg, meters, ...base } = before;
      const next = { ...base, office: "tour", name: c.name, address: c.address, category: c.category, lat: c.lat, lon: c.lon, kakaoUrl: c.kakaoUrl, by: session ? session.id : null };
      delete next.id;
      if (!(await write("restaurants", id, next))) return;
      // 다른 가게로 바꾸면 이미 남긴 별점도 새 가게로 옮김
      const newKey = shopKey({ id, ...next });
      if (key && key !== newKey) {
        for (const r of ratings) {
          const { rid, ...data } = r;
          await write("ratings", ratingId(newKey, r.person), { ...data, shop: newKey, name: c.name });
          await write("ratings", rid, null);
        }
      }
      delete state.candidates[id];
      state.editing = null;
      toast(`'${c.name}'을(를) 지도에 표시했어요.`);
      fitMap();
      return select(id, false);
    }

    if (t.dataset.remove) {
      const id = t.dataset.remove;
      if (state.confirmRemove !== id) {
        state.confirmRemove = id;
        render();
        setTimeout(() => { if (state.confirmRemove === id) { state.confirmRemove = null; render(); } }, 3000);
        return;
      }
      state.confirmRemove = null;
      const cur = store.restaurants[id] || PRESET.find((p) => p.id === id) || {};
      // 처음 받은 링크는 "뺐음" 표시만, 추가한 링크는 지움 (별점은 그대로 남음)
      const ok = PRESET.some((p) => p.id === id)
        ? await write("restaurants", id, { ...cur, office: "tour", removed: true })
        : await write("restaurants", id, null);
      if (ok) { if (state.selected === id) state.selected = null; toast("목록에서 뺐어요."); }
      return;
    }

    const half = t.closest("[data-stars]");
    const group = half && half.closest("[data-rate]");
    if (group && session) {
      const s = places().find((x) => x.id === group.dataset.rate);
      if (!s || !s.key) return;
      const stars = Number(half.dataset.stars);
      const id = ratingId(s.key, session.id);
      const cur = store.ratings[id];
      const clear = cur && cur.stars === stars;
      const ok = clear
        ? await write("ratings", id, null)
        : await write("ratings", id, { ...(cur || {}), shop: s.key, name: s.name, office: BASE_OFFICE, person: session.id, stars, at: new Date().toISOString(), tour: true });
      if (ok) toast(clear ? `${s.name} 별점을 지웠어요.` : `${s.name}에 별점 ${stars.toFixed(1)}점을 줬어요.`);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && auth.open) { auth.open = false; renderMe(); }
  });

  render();
  connect();
  initMap();
})();
