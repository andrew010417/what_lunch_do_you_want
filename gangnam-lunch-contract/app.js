// =====================================================================
// 강남 점심 계약 식당 고르기: 후보 식당을 지도에 표시하고, 다녀올 때마다 평가를 남김
// - 설정(카카오 키, Supabase, 사무실 위치)은 config.js
// - 기록은 점심 고르기와 같은 Supabase 표(lunch_docs)에 저장
//   restaurants: id "tour_…" (office: "tour" 라 점심 고르기 가게 목록에는 안 보임)
//   ratings: id "vt_…" = 방문 1번의 평가 { kind: "visit", place, who, stars, note, date }
//            (shop 칸이 없어서 점심 고르기의 가게 별점에는 섞이지 않음)
// - 로그인 없이 이름만 적고 평가 (점심 고르기에 로그인돼 있으면 그 이름을 씀)
// =====================================================================
(() => {
  // 계약 후보 식당 (받은 링크 8개에서 확인한 가게 · 좌표는 네이버 지도 기준)
  // - 위치가 틀리면 화면의 "위치가 틀렸나요?"로 고치면 모두에게 저장됨
  // - 후보를 바꾸려면 이 목록을 고치면 됨 (id 는 평가 기록과 연결되니 기존 것은 바꾸지 말 것)
  const PRESET = [
    { id: "tour_1", name: "찬스찬스", category: "한식", address: "서울 서초구 서운로 136 르피에드인강남 지하1층",
      lat: 37.4956165, lon: 127.0252197, link: "https://naver.me/FhfQ2qZV", title: "네이버 지도" },
    { id: "tour_2", name: "썬앤문", category: "맥주·호프", address: "서울 서초구 서초대로77길 39 MK빌딩",
      lat: 37.5011606, lon: 127.0251656, link: "https://naver.me/Ge7MElh4", title: "네이버 지도" },
    { id: "tour_3", name: "오늘통닭 강남역점", category: "한식뷔페", address: "서울 서초구 서초대로74길 33 비트빌빌딩 1층",
      lat: 37.4946532, lon: 127.0277713, link: "https://blog.naver.com/ho_ooon/224446248821", title: "블로그: 점심뷔페 추천, 혼밥 가능" },
    { id: "tour_4", name: "놀란치킨 강남역본점", category: "한식뷔페", address: "서울 서초구 서초대로74길 29 1층",
      lat: 37.4951182, lon: 127.0274495, link: "https://blog.naver.com/rnbthug/224370527091", title: "블로그: 9천원으로 즐기는 한식뷔페" },
    { id: "tour_5", name: "강남백반집", category: "한식뷔페", address: "서울 서초구 서초대로77길 13 지하1층",
      lat: 37.4988539, lon: 127.0261436, link: "https://blog.naver.com/swannnzy/224383397593", title: "블로그: 직장인 점심 혼밥 한식뷔페" },
    { id: "tour_6", name: "광장포차", category: "한식뷔페", address: "서울 강남구 강남대로96길 20 2층",
      lat: 37.4999433, lon: 127.0286453, link: "https://blog.naver.com/ashley700/224419818147", title: "블로그: 점심 한식뷔페, 직장인 혼밥" },
    { id: "tour_7", name: "밀회관 강남삼성타운점", category: "한식뷔페", address: "서울 서초구 강남대로53길 8 스타크강남빌딩 1층",
      lat: 37.494467, lon: 127.0280899, link: "https://blog.naver.com/tkdzmaaldald/224347521749", title: "블로그: 점심 한식뷔페, 가성비" },
    { id: "tour_8", name: "속초오징어어시장 강남역점", category: "한식뷔페", address: "서울 강남구 강남대로78길 16 1층",
      lat: 37.4950064, lon: 127.0307028, link: "https://blog.naver.com/sungjoonman/224374006977", title: "블로그: 8,500원, 라면·계란 무한리필" },
  ];
  const SEARCH_RADIUS = 5000;            // 가게 이름으로 찾을 범위(m)
  const WALK_METERS_PER_MIN = 67;
  const SESSION_KEY = "bionexus-lunch-session";
  const NAME_KEY = "bionexus-tour-name";
  const MINE_KEY = "bionexus-tour-mine"; // 이 브라우저에서 남긴 평가 (지울 수 있게)
  const TABLE = "lunch_docs";
  const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (typeof u === "string" && /^https?:\/\/[^\s"<>]+$/i.test(u) ? u : null);
  const isKakaoPlaceUrl = (u) => typeof u === "string" && /^https?:\/\/place\.map\.kakao\.com\/\d+$/.test(u);
  const readJson = (k, f) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? f : v; } catch (e) { return f; } };
  const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 안 돼도 동작 */ } };
  const pad = (n) => String(n).padStart(2, "0");
  const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const shortDate = (k) => (typeof k === "string" && /^\d{4}-\d{2}-\d{2}$/.test(k) ? `${Number(k.slice(5, 7))}/${Number(k.slice(8))}` : "");

  const store = { people: {}, restaurants: {}, ratings: {} };
  const state = { sort: "no", selected: null, editing: null, rating: null, draft: {}, candidates: {}, searching: null, conn: "connecting" };
  let sb = null;
  const session = (() => { const s = readJson(SESSION_KEY, null); return s && typeof s.id === "string" ? s : null; })();
  let mine = new Set(readJson(MINE_KEY, []));

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
    if (state.conn !== "ok") { toast("공유 저장소에 연결되지 않아 저장할 수 없어요. 새로고침해 주세요."); return false; }
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
  // 식당 · 평가
  // ------------------------------------------------------------------
  const officeCoords = { ...OFFICE.location };
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
  const myName = () => {
    const p = session && store.people[session.id];
    return readJson(NAME_KEY, "") || (p && typeof p.name === "string" ? p.name : "");
  };

  function places() {
    const saved = store.restaurants;
    const visits = Object.entries(store.ratings)
      .filter(([id, r]) => id.startsWith("vt_") && r && r.kind === "visit" && validStars(r.stars) && typeof r.place === "string")
      .map(([rid, r]) => ({ rid, ...r }));
    return PRESET.map((p, i) => {
      const s = { ...p, ...(saved[p.id] && saved[p.id].office === "tour" ? saved[p.id] : {}) };
      const linked = typeof s.name === "string" && s.name !== "" && hasCoords(s);
      const vs = visits.filter((v) => v.place === p.id)
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.at || "").localeCompare(String(a.at || "")));
      const avg = vs.length ? vs.reduce((a, v) => a + v.stars, 0) / vs.length : 0;
      const who = new Set(vs.map((v) => String(v.who || "").trim().toLowerCase()).filter(Boolean));
      return { ...s, no: i + 1, linked, visits: vs, avg, people: who.size, meters: linked ? distanceM(officeCoords, s) : null };
    });
  }

  function sorted(list) {
    const copy = [...list];
    if (state.sort === "rating") copy.sort((a, b) => b.avg - a.avg || b.visits.length - a.visits.length || a.no - b.no);
    if (state.sort === "near") copy.sort((a, b) => (a.meters ?? 1e9) - (b.meters ?? 1e9) || a.no - b.no);
    if (state.sort === "todo") copy.sort((a, b) => (a.visits.length > 0) - (b.visits.length > 0) || a.no - b.no);
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
        new kakao.maps.services.Geocoder().addressSearch(OFFICE.address, (res, status) => {
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
      return true;
    } catch (e) {
      $("map-note").innerHTML = `카카오 지도를 불러오지 못했어요. 잠시 후 새로고침해 주세요.
        (회사 보안 프로그램이 지도를 막는 경우도 있어요. 목록과 평가는 그대로 쓸 수 있어요.)`;
      return false;
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
        content: `<div class="pin office">🏢 우리 사무실</div>`, yAnchor: 1.2, zIndex: 2,
      });
    }
    list.filter((s) => s.linked).forEach((s) => {
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = `pin tour-pin${s.visits.length ? " visited" : ""}${state.selected === s.id ? " selected" : ""}`;
      pin.textContent = String(s.no);
      pin.setAttribute("aria-label", `${s.no}번 ${s.name}`);
      const tip = document.createElement("span");
      tip.className = "pin-tip";
      tip.textContent = `${s.name}${s.visits.length ? ` · ★${s.avg.toFixed(1)} (${s.visits.length}회)` : " · 아직 안 가봄"}`;
      pin.appendChild(tip);
      const z = state.selected === s.id ? 5 : 1;
      const overlay = new kakao.maps.CustomOverlay({ map, position: new kakao.maps.LatLng(s.lat, s.lon), content: pin, yAnchor: 1.1, zIndex: z });
      pin.addEventListener("mouseenter", () => overlay.setZIndex(10));
      pin.addEventListener("mouseleave", () => overlay.setZIndex(z));
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

  // 가게 이름 → 사무실 근처 카카오맵 장소 (정확도순)
  async function findPlaces(query) {
    const kakao = await loadKakao();
    const S = kakao.maps.services;
    const found = await new Promise((resolve, reject) => {
      new S.Places().keywordSearch(query, (data, status) => {
        if (status === S.Status.OK) resolve(data);
        else if (status === S.Status.ZERO_RESULT) resolve([]);
        else reject(new Error("search"));
      }, { location: new kakao.maps.LatLng(officeCoords.lat, officeCoords.lon), radius: SEARCH_RADIUS, sort: S.SortBy.ACCURACY, size: 6 });
    });
    return found.map((p) => ({
      name: p.place_name,
      address: p.road_address_name || p.address_name || "",
      category: (p.category_name || "").split(" > ").pop(),
      lat: Number(p.y), lon: Number(p.x),
      kakaoUrl: isKakaoPlaceUrl(p.place_url) ? p.place_url : "",
    })).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  }

  async function searchPlaces(id, query) {
    state.searching = id;
    state.candidates[id] = null;
    render();
    state.candidates[id] = await findPlaces(query).catch(() => "error");
    state.searching = null;
    render();
  }

  async function saveLocation(id, c, announce = true) {
    const ok = await write("restaurants", id, {
      office: "tour", name: c.name, address: c.address, category: c.category,
      lat: c.lat, lon: c.lon, kakaoUrl: c.kakaoUrl, at: new Date().toISOString(),
    });
    if (ok && announce) toast(`'${c.name}'을(를) 지도에 표시했어요.`);
    return ok;
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

  const summaryBadge = (s) => (s.visits.length
    ? `<span class="tour-badge done">★ ${s.avg.toFixed(1)} · ${s.visits.length}회 · ${s.people}명</span>`
    : `<span class="tour-badge">아직 안 가봄</span>`);

  function linksHtml(s) {
    const link = safeUrl(s.link);
    return `<div class="tour-links">
      ${link ? `<a class="primary small" href="${esc(link)}" target="_blank" rel="noopener">📖 후기·링크 보기 ↗</a>` : ""}
      ${s.linked && isKakaoPlaceUrl(s.kakaoUrl) ? `<a class="ghost small" href="${esc(s.kakaoUrl)}" target="_blank" rel="noopener">카카오맵 ↗</a>` : ""}
      ${s.linked ? `<a class="ghost small" href="https://map.kakao.com/link/to/${encodeURIComponent(s.name)},${s.lat},${s.lon}" target="_blank" rel="noopener">길찾기 ↗</a>` : ""}
    </div>`;
  }

  // 다녀온 뒤 평가 남기기 (방문할 때마다 한 줄씩)
  function rateForm(s) {
    if (state.rating !== s.id) {
      return `<button type="button" class="primary tour-rate-open" data-rate-open="${esc(s.id)}">✍️ 다녀왔어요 · 평가 남기기</button>`;
    }
    const d = state.draft[s.id] || (state.draft[s.id] = { stars: 0 });
    const names = [...new Set(Object.values(store.people)
      .filter((p) => p && p.office === OFFICE.key && typeof p.name === "string").map((p) => p.name))];
    return `<form class="tour-rate-form" data-rate-form="${esc(s.id)}">
      <div class="tour-rate">
        <span class="tour-rate-label">별점</span>
        <span class="stars" data-draft="${esc(s.id)}" role="group" aria-label="${esc(s.name)} 별점, 0.5점 단위">${starsHtml(d.stars, true)}</span>
        <span class="star-value">${d.stars ? d.stars.toFixed(1) : ""}</span>
      </div>
      <p class="hint tight">별 왼쪽 반은 0.5점이에요.</p>
      <div class="tour-rate-fields">
        <label>이름 <input name="who" maxlength="20" list="tour-names" value="${esc(d.who ?? myName())}" placeholder="예: 박재형" required /></label>
        <label>다녀온 날 <input name="date" type="date" max="${todayKey()}" value="${esc(d.date || todayKey())}" required /></label>
      </div>
      <input name="note" maxlength="80" placeholder="한줄평 (선택, 예: 양 많고 빨리 나옴, 웨이팅 10분)" value="${esc(d.note || "")}" />
      <datalist id="tour-names">${names.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="tour-tools">
        <button class="primary small" type="submit">평가 저장</button>
        <button class="ghost small" type="button" data-rate-cancel>취소</button>
      </div>
    </form>`;
  }

  function visitsHtml(s) {
    if (!s.visits.length) return "";
    return `<ul class="tour-reviews">${s.visits.map((v) => {
      const canDelete = mine.has(v.rid) || (session && v.person === session.id);
      return `<li>
        <span class="tour-date">${esc(shortDate(v.date))}</span>
        <b>${esc(String(v.who || "익명"))}</b>
        <span class="stars tiny">${starsHtml(v.stars, false)}</span> ${v.stars.toFixed(1)}
        ${typeof v.note === "string" && v.note ? `<span class="tour-note-text">“${esc(v.note)}”</span>` : ""}
        ${canDelete ? `<button type="button" class="link-button" data-del-visit="${esc(v.rid)}">${state.confirmDel === v.rid ? "정말 지울까요?" : "지우기"}</button>` : ""}
      </li>`;
    }).join("")}</ul>`;
  }

  function linkForm(s) {
    const c = state.candidates[s.id];
    let found = "";
    if (state.searching === s.id) found = `<p class="hint tight">카카오맵에서 찾는 중…</p>`;
    else if (c === "error") found = `<p class="hint tight error">카카오맵 검색이 안 돼요. 잠시 후 다시 해 주세요.</p>`;
    else if (Array.isArray(c) && !c.length) found = `<p class="hint tight">찾는 가게가 없어요. 지점 이름까지 넣어 보세요. (예: ○○식당 강남점)</p>`;
    else if (Array.isArray(c)) {
      found = `<ul class="tour-candidates">${c.map((p, i) => `
        <li><button type="button" class="ghost small" data-pick="${esc(s.id)}:${i}">이 가게예요</button>
          <span><b>${esc(p.name)}</b> <span class="shop-meta">${esc(p.category)} · ${esc(p.address)} · 사무실에서 ${fmtMeters(distanceM(officeCoords, p))}</span></span></li>`).join("")}</ul>`;
    }
    return `<p class="hint tight">${s.linked ? "위치가 틀렸으면 가게 이름으로 다시 찾아 주세요." : "후기 링크를 열어 가게 이름을 확인하고 입력하면, 지도에 표시되고 모두에게 저장돼요."}</p>
      <form class="tour-link-form" data-search="${esc(s.id)}">
        <input name="q" maxlength="40" placeholder="가게 이름 (예: ○○식당 강남점)" value="${esc(s.name || "")}" required />
        <button class="ghost small" type="submit">카카오맵에서 찾기</button>
        ${s.linked ? `<button class="link-button" type="button" data-cancel>취소</button>` : ""}
      </form>${found}`;
  }

  function itemHtml(s) {
    const meta = s.linked
      ? [s.category, s.address, `📍 사무실에서 ${fmtMeters(s.meters)} · 도보 ${walkMinutes(s.meters)}분`].filter(Boolean).map(esc).join(" · ")
      : "";
    return `<li class="tour-item${state.selected === s.id ? " selected" : ""}" id="item-${esc(s.id)}">
      <span class="pin-no ${s.visits.length ? "visited" : ""}">${s.no}</span>
      <div class="tour-body">
        <div class="tour-title">
          ${s.linked ? `<button type="button" class="tour-name" data-select="${esc(s.id)}">${esc(s.name)}</button>` : `<span class="tour-name empty">후보 ${s.no} · 위치 미등록</span>`}
          ${summaryBadge(s)}
        </div>
        <div class="shop-meta">${esc(s.title || "")}${meta ? ` · ${meta}` : ""}</div>
        ${linksHtml(s)}
        ${state.editing === s.id || !s.linked ? linkForm(s) : ""}
        ${visitsHtml(s)}
        ${rateForm(s)}
        ${s.linked && state.editing !== s.id ? `<div class="tour-tools"><button type="button" class="link-button" data-edit="${esc(s.id)}">위치가 틀렸나요?</button></div>` : ""}
      </div>
    </li>`;
  }

  function renderPopup(list) {
    const s = list.find((x) => x.id === state.selected && x.linked);
    $("popup").hidden = !s;
    if (!s) return;
    $("popup").innerHTML = `
      <div class="tour-title">
        <span class="pin-no ${s.visits.length ? "visited" : ""}">${s.no}</span>
        <strong>${esc(s.name)}</strong>
        ${summaryBadge(s)}
        <button type="button" class="link-button tour-close" data-close-popup>닫기 ✕</button>
      </div>
      <div class="shop-meta">${esc(s.category || "")} · 📍 사무실에서 ${fmtMeters(s.meters)} · 도보 ${walkMinutes(s.meters)}분</div>
      ${linksHtml(s)}
      <div class="tour-tools"><button type="button" class="ghost small" data-goto="${esc(s.id)}">✍️ 평가 남기기 · 다른 분 평가 보기</button></div>`;
  }

  function renderSummary(list) {
    const visited = list.filter((s) => s.visits.length);
    const total = list.reduce((a, s) => a + s.visits.length, 0);
    const pct = Math.round((visited.length / list.length) * 100);
    const ranked = [...visited].sort((a, b) => b.avg - a.avg || b.visits.length - a.visits.length);
    $("progress").innerHTML = `
      <div class="tour-stat"><b>${visited.length}</b> / ${list.length}곳 가봤어요 <span class="hint tight">(평가 ${total}개)</span></div>
      <div class="tour-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
      ${ranked.length ? `
        <div class="tag-group-name">🏆 현재 순위 (평균 별점)</div>
        <ol class="tour-rank">${ranked.map((s, i) => `
          <li><span class="tour-rank-no">${i + 1}</span>
            <button type="button" class="tour-name" data-goto="${esc(s.id)}">${esc(s.linked ? s.name : `후보 ${s.no}`)}</button>
            <span class="stars tiny">${starsHtml(Math.round(s.avg * 2) / 2, false)}</span>
            <b>${s.avg.toFixed(1)}</b> <span class="shop-meta">${s.visits.length}회 · ${s.people}명${s.meters != null ? ` · 도보 ${walkMinutes(s.meters)}분` : ""}</span></li>`).join("")}</ol>
        ${list.length > visited.length ? `<p class="hint tight">아직 안 가본 곳: ${list.filter((s) => !s.visits.length).map((s) => esc(s.linked ? s.name : `후보 ${s.no}`)).join(", ")}</p>` : ""}`
      : `<p class="hint tight">다녀온 뒤 ✍️ 평가를 남기면 여기에 순위가 생겨요. 같은 곳을 여러 번 가도 갈 때마다 남겨 주세요.</p>`}`;
  }

  function render() {
    const list = places();
    $("sync").textContent = { connecting: "연결 중…", ok: "● 모두와 실시간 공유 중", fail: "공유 저장소 연결 실패 · 새로고침해 주세요" }[state.conn];
    $("sync").dataset.mode = state.conn === "ok" ? "shared" : "";
    renderSummary(list);
    $("sort-chips").innerHTML = [["no", "번호순"], ["rating", "별점순"], ["near", "가까운 순"], ["todo", "안 가본 곳 먼저"]]
      .map(([k, label]) => `<button class="chip tap ${state.sort === k ? "active" : ""}" data-sort="${k}" aria-pressed="${state.sort === k}">${label}</button>`).join("");
    // 다른 사람이 저장해서 다시 그려져도 쓰던 글자 유지
    const active = document.activeElement;
    const form = active && active.form;
    const keep = form && (form.dataset.search || form.dataset.rateForm) && active.name
      ? `form[data-${form.dataset.search ? "search" : "rate-form"}="${form.dataset.search || form.dataset.rateForm}"] [name="${active.name}"]` : null;
    if (form && form.dataset.rateForm) saveDraft(form);
    const typed = keep ? active.value : null;
    $("list").innerHTML = sorted(list).map(itemHtml).join("");
    if (keep) { const el = document.querySelector(keep); if (el) { el.value = typed; el.focus(); } }
    renderPopup(list);
    drawPins(list);
  }

  function saveDraft(form) {
    const d = state.draft[form.dataset.rateForm] || (state.draft[form.dataset.rateForm] = { stars: 0 });
    const fd = new FormData(form);
    d.who = String(fd.get("who") || "");
    d.date = String(fd.get("date") || "");
    d.note = String(fd.get("note") || "");
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
  // 이벤트
  // ------------------------------------------------------------------
  document.addEventListener("submit", async (e) => {
    const search = e.target.closest("[data-search]");
    if (search) {
      e.preventDefault();
      const q = String(new FormData(search).get("q") || "").trim();
      if (q) searchPlaces(search.dataset.search, q);
      return;
    }
    const form = e.target.closest("[data-rate-form]");
    if (!form) return;
    e.preventDefault();
    const s = places().find((x) => x.id === form.dataset.rateForm);
    const d = state.draft[form.dataset.rateForm] || { stars: 0 };
    saveDraft(form);
    if (!s) return;
    if (!d.stars) return toast("별을 눌러 별점을 골라 주세요.");
    const who = d.who.trim().slice(0, 20);
    if (!who) return toast("이름을 적어 주세요.");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.date <= todayKey() ? d.date : todayKey();
    const id = `vt_${s.id}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const ok = await write("ratings", id, {
      kind: "visit", tour: true, place: s.id, name: s.linked ? s.name : `후보 ${s.no}`,
      who, person: session ? session.id : null, stars: d.stars, note: d.note.trim().slice(0, 80), date, at: new Date().toISOString(),
    });
    if (!ok) return;
    mine.add(id);
    writeJson(MINE_KEY, [...mine]);
    writeJson(NAME_KEY, who);
    delete state.draft[s.id];
    state.rating = null;
    toast(`${s.linked ? s.name : `후보 ${s.no}`} 평가를 저장했어요. 고마워요!`);
    render();
  });

  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.sort) { state.sort = t.dataset.sort; return render(); }
    if (t.dataset.select) return select(t.dataset.select, true);
    if ("closePopup" in t.dataset) { state.selected = null; return render(); }
    if (t.dataset.goto) {
      state.selected = t.dataset.goto;
      render();
      const el = $(`item-${t.dataset.goto}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (t.dataset.edit) { state.editing = t.dataset.edit; return render(); }
    if ("cancel" in t.dataset) { state.editing = null; return render(); }
    if (t.dataset.rateOpen) {
      state.rating = t.dataset.rateOpen;
      render();
      const stars = document.querySelector(`[data-draft="${t.dataset.rateOpen}"] .star-half`);
      if (stars) stars.focus();
      return;
    }
    if ("rateCancel" in t.dataset) { state.rating = null; return render(); }

    const half = t.closest("[data-stars]");
    const group = half && half.closest("[data-draft]");
    if (group) {
      const form = group.closest("form");
      if (form) saveDraft(form);
      const d = state.draft[group.dataset.draft] || (state.draft[group.dataset.draft] = { stars: 0 });
      const v = Number(half.dataset.stars);
      d.stars = d.stars === v ? 0 : v;
      return render();
    }

    if (t.dataset.pick) {
      const [id, i] = t.dataset.pick.split(":");
      const c = (state.candidates[id] || [])[Number(i)];
      if (!c || !(await saveLocation(id, c))) return;
      delete state.candidates[id];
      state.editing = null;
      fitMap();
      return select(id, false);
    }

    if (t.dataset.delVisit) {
      const id = t.dataset.delVisit;
      if (state.confirmDel !== id) {
        state.confirmDel = id;
        render();
        setTimeout(() => { if (state.confirmDel === id) { state.confirmDel = null; render(); } }, 3000);
        return;
      }
      state.confirmDel = null;
      if (await write("ratings", id, null)) {
        mine.delete(id);
        writeJson(MINE_KEY, [...mine]);
        toast("평가를 지웠어요.");
      }
    }
  });

  render();
  initMap();
  connect();
})();
