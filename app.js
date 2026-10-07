(() => {
  const AVATAR_COLORS = [
    "#f59e0b", "#ef4444", "#10b981", "#3b82f6", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
  ];
  const STORAGE_KEY = "bionexus-lunch-selection";
  const HIDE_KEY = "bionexus-lunch-hide-disliked";

  const $ = (id) => document.getElementById(id);
  const state = {
    office: "gangnam",
    selected: new Set(loadSelection()),
    hideDisliked: loadHide(),
    lastClicked: null,
  };

  function loadHide() {
    try { return localStorage.getItem(HIDE_KEY) === "1"; } catch (_) { return false; }
  }

  function saveHide() {
    try { localStorage.setItem(HIDE_KEY, state.hideDisliked ? "1" : "0"); } catch (_) {}
  }


  function loadSelection() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      // 선택은 그날 하루만 유지
      if (saved && saved.date === new Date().toDateString()) return saved.names;
    } catch (_) {}
    return [];
  }

  function saveSelection() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        date: new Date().toDateString(),
        names: [...state.selected],
      }));
    } catch (_) {}
  }

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

  // 제작자 전용 아이콘: 정장 + 넥타이 + 선글라스 + 반짝이
  function makerAvatarSvg() {
    return `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id="maker-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#fcd34d" />
            <stop offset="1" stop-color="#b45309" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="30" fill="#1e293b" stroke="url(#maker-ring)" stroke-width="2.5" />
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

  function renderPeople() {
    const people = OFFICES[state.office].people;
    $("people").innerHTML = people.map((p, i) => `
      <button class="person${p.maker ? " maker" : ""}" data-name="${p.name}" aria-pressed="${state.selected.has(p.name)}">
        <span class="check">✓</span>
        ${p.maker ? makerAvatarSvg() : avatarSvg(AVATAR_COLORS[i % AVATAR_COLORS.length])}
        <span class="name">${p.name}님</span>
        ${p.maker ? `<span class="maker-badge">👑 제작자</span>` : ""}
      </button>`).join("");

    const n = state.selected.size;
    $("selection-summary").textContent = n === 0
      ? "아무도 선택하지 않으면 모든 메뉴를 기본 순서로 보여줍니다."
      : `오늘 ${n}명: ${[...state.selected].map((s) => s + "님").join(", ")}`;
  }

  // 선택된 사람들의 취향으로 메뉴 점수 계산
  function scoreMenus() {
    const people = OFFICES[state.office].people.filter((p) => state.selected.has(p.name));
    return MENUS.map((menu, index) => {
      const ups = [];
      const downs = [];
      for (const p of people) {
        const liked = p.likes.filter((t) => menu.tags.includes(t));
        const disliked = p.dislikes.filter((t) => menu.tags.includes(t));
        if (liked.length) ups.push({ who: p.name, tags: liked });
        if (disliked.length) downs.push({ who: p.name, tags: disliked });
      }
      // 좋아하는 사람 1명당 +1, 싫어하는 사람 1명당 -1
      const score = ups.length - downs.length;
      return { ...menu, index, score, ups, downs };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
  }

  // 순위에 보여줄 메뉴 (숨기기 모드면 한 명이라도 싫어하는 메뉴 제외)
  function visibleMenus() {
    const ranked = scoreMenus();
    return state.hideDisliked ? ranked.filter((m) => m.downs.length === 0) : ranked;
  }

  function renderMenus() {
    const all = scoreMenus();
    const ranked = visibleMenus();
    const hiddenCount = all.length - ranked.length;
    $("hidden-summary").hidden = !state.hideDisliked;
    $("hidden-summary").textContent = hiddenCount
      ? `누군가 싫어하는 메뉴 ${hiddenCount}개를 숨겼어요: ${all.filter((m) => m.downs.length).map((m) => m.name).join(", ")}`
      : "숨긴 메뉴가 없어요. 체크한 사람 중 아무도 싫어하는 메뉴가 없습니다.";
    const fmt = (list) => list.map((r) => `${r.who}님(${r.tags.join(", ")})`).join(", ");

    $("menus").innerHTML = ranked.map((m, i) => {
      const cls = m.score > 0 ? "good" : m.score < 0 ? "bad" : "";
      const badge = m.score > 0 ? `추천 +${m.score}` : m.score < 0 ? `비추 ${m.score}` : "";
      const reasons = [
        m.ups.length ? `<div class="up">👍 ${fmt(m.ups)}</div>` : "",
        m.downs.length ? `<div class="down">👎 ${fmt(m.downs)}</div>` : "",
      ].join("");
      return `
        <li class="menu ${cls}" data-menu="${m.name}">
          <span class="rank">${i + 1}</span>
          <span class="emoji">${m.emoji}</span>
          <div>
            <div class="title">${m.name}</div>
            <div class="tags">${m.tags.map((t) => `<span class="tag">#${t}</span>`).join("")}</div>
            ${reasons ? `<div class="reasons">${reasons}</div>` : ""}
          </div>
          ${badge ? `<span class="badge">${badge}</span>` : "<span></span>"}
        </li>`;
    }).join("");
  }

  // 가장 최근에 누른 사람의 취향 카드
  function renderFocus() {
    const box = $("focus");
    const p = OFFICES[state.office].people.find((x) => x.name === state.lastClicked);
    box.hidden = !p;
    if (!p) return;

    const menusFor = (tags) => MENUS.filter((m) => tags.some((t) => m.tags.includes(t))).map((m) => m.name);
    const chips = (tags, cls) => tags.map((t) => `<span class="chip ${cls}">#${t}</span>`).join("");
    const row = (title, prefs, cls) => `
      <div class="focus-row">
        <div class="focus-label ${cls}">${title}</div>
        ${prefs.length
          ? `<div class="chips">${chips(prefs, cls)}</div><div class="focus-menus">→ ${menusFor(prefs).join(", ")}</div>`
          : `<div class="focus-empty">아직 등록된 정보가 없어요</div>`}
      </div>`;

    const on = state.selected.has(p.name);
    box.innerHTML = `
      <div class="focus-head">
        <strong>${p.name}님</strong>
        <span class="focus-state ${on ? "on" : ""}">${on ? "오늘 출근 ✓" : "선택 해제됨"}</span>
      </div>
      ${row("👍 좋아하는 음식", p.likes, "up")}
      ${row("👎 싫어하는 음식", p.dislikes, "down")}`;
  }

  function pickRandom() {
    const ranked = visibleMenus();
    if (!ranked.length) return;
    const top = ranked[0].score;
    const pool = top > 0
      ? ranked.filter((m) => m.score === top)
      : ranked.filter((m) => m.score >= 0);
    const choice = pool[Math.floor(Math.random() * pool.length)];

    const box = $("pick-result");
    box.hidden = false;
    box.textContent = `오늘의 점심은… ${choice.emoji} ${choice.name}!`;

    const el = document.querySelector(`[data-menu="${CSS.escape(choice.name)}"]`);
    if (el) {
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function render() {
    renderTabs();
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
    renderMenus();
    $("hide-disliked").checked = state.hideDisliked;
  }

  $("tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    state.office = tab.dataset.office;
    render();
  });

  $("people").addEventListener("click", (e) => {
    const btn = e.target.closest(".person");
    if (!btn) return;
    const name = btn.dataset.name;
    state.selected.has(name) ? state.selected.delete(name) : state.selected.add(name);
    state.lastClicked = name;
    $("pick-result").hidden = true;
    saveSelection();
    render();
  });

  $("select-all").addEventListener("click", () => {
    OFFICES[state.office].people.forEach((p) => state.selected.add(p.name));
    saveSelection();
    render();
  });

  $("clear-all").addEventListener("click", () => {
    state.selected.clear();
    state.lastClicked = null;
    $("pick-result").hidden = true;
    saveSelection();
    render();
  });

  $("pick").addEventListener("click", pickRandom);

  $("hide-disliked").addEventListener("change", (e) => {
    state.hideDisliked = e.target.checked;
    $("pick-result").hidden = true;
    saveHide();
    render();
  });

  render();
})();
