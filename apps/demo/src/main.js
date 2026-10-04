const API = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
const TOKEN_KEY = "life-demo-token";
const INSTALLATION_KEY = "life-demo-installation";
let accessToken = localStorage.getItem(TOKEN_KEY);
let activeSessionId = null;
let currentTargetId = null;
let feedbackPending = false;
const excludedObjectIds = new Set();

const byId = (id) => document.getElementById(id);
byId("api-url-label").textContent = API;

function setSessionLabel(text) {
  byId("session-state").textContent = text;
}

async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (accessToken) headers.Authorization = "Bearer " + accessToken;
  const response = await fetch(API + path, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) {
    const error = payload.error || {};
    if (response.status === 401) {
      accessToken = null;
      localStorage.removeItem(TOKEN_KEY);
      setSessionLabel("登录过期，请重新登录");
    }
    throw new Error(error.message || error.code || "请求失败");
  }
  return payload.data;
}

function addText(parent, tag, value, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value == null ? "" : String(value);
  parent.append(element);
  return element;
}

function updateLoginState() {
  if (accessToken) {
    setSessionLabel("已连接本地演示账户");
    byId("login-button").textContent = "重新登录";
    refreshAll();
  }
}

byId("login-button").addEventListener("click", async () => {
  try {
    const installation = localStorage.getItem(INSTALLATION_KEY) || crypto.randomUUID();
    localStorage.setItem(INSTALLATION_KEY, installation);
    const data = await request("/v1/auth/wechat/login", {
      method: "POST",
      body: JSON.stringify({ code: installation, clientInstallationId: installation }),
    });
    accessToken = data.accessToken;
    localStorage.setItem(TOKEN_KEY, accessToken);
    updateLoginState();
  } catch (error) {
    setSessionLabel(error.message);
  }
});

byId("capture-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = byId("capture-text").value.trim();
  if (!text) return;
  const submit = event.submitter;
  if (submit.disabled) return;
  submit.disabled = true;
  const message = byId("capture-message");
  message.textContent = "";
  try {
    const data = await request("/v1/captures", {
      method: "POST",
      headers: { "X-Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ type: "TEXT", text, sourceChannel: "DEMO" }),
    });
    byId("capture-text").value = "";
    message.textContent = "收到了。后台正在理解这条记录。";
    renderCapture(
      {
        id: data.captureId,
        type: "TEXT",
        status: data.status,
        text,
        createdAt: new Date().toISOString(),
      },
      true,
    );
    pollCapture(data.captureId);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

async function pollCapture(id) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const capture = await request("/v1/captures/" + encodeURIComponent(id));
      renderCapture(capture, true);
      if (
        capture.status === "READY" ||
        capture.status === "NEEDS_REVIEW" ||
        capture.status === "FAILED"
      ) {
        await refreshLife();
        return;
      }
    } catch (error) {
      byId("capture-message").textContent = error.message;
      return;
    }
  }
}

function renderCapture(capture, prepend = false) {
  const list = byId("capture-list");
  const existing = list.querySelector('[data-id="' + CSS.escape(capture.id) + '"]');
  if (existing) existing.remove();
  if (list.querySelector(".empty")) list.replaceChildren();
  const item = document.createElement("article");
  item.className = "capture-item";
  item.dataset.id = capture.id;
  const state =
    capture.status === "READY"
      ? "已理解"
      : capture.status === "FAILED"
        ? "处理失败，原文仍保留"
        : capture.status === "NEEDS_REVIEW"
          ? "需要再看一眼"
          : "后台处理中";
  addText(item, "span", state, "status " + capture.status.toLowerCase());
  addText(item, "p", capture.text, "capture-text");
  addText(
    item,
    "time",
    new Date(capture.createdAt).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    "time",
  );
  prepend ? list.prepend(item) : list.append(item);
}

function renderLife(items) {
  const list = byId("life-list");
  list.replaceChildren();
  if (!items.length) {
    addText(list, "div", "还没有可用的生活对象。先留下一个想法。", "empty");
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "life-item";
    addText(card, "span", item.kind || "生活事项", "kind");
    addText(card, "h3", item.title);
    if (item.summary) addText(card, "p", item.summary);
    list.append(card);
  }
}

function renderRecommendation(result) {
  const host = byId("recommendation");
  host.replaceChildren();
  activeSessionId = result.sessionId;
  currentTargetId = result.recommendation?.targetLifeObjectId || null;
  if (result.status === "QUIET" || !result.recommendation) {
    addText(
      host,
      "p",
      result.candidates.length
        ? "这会儿没有足够合适的行动，先不打扰。"
        : "还没有可推荐的记录。再留下一两件真正想做的事。",
      "quiet-note",
    );
    return;
  }
  const card = document.createElement("article");
  card.className = "action-card";
  addText(card, "span", "现在最值得做的一件事", "action-kicker");
  addText(card, "h3", result.recommendation.headline);
  addText(card, "p", result.recommendation.body);
  addText(card, "small", result.recommendation.reasonText, "reason");
  const actions = document.createElement("div");
  actions.className = "feedback-actions";
  const accept = addText(actions, "button", "就这样", "accept-button");
  const skip = addText(actions, "button", "换一个", "skip-button");
  accept.type = skip.type = "button";
  accept.addEventListener("click", () => sendFeedback("ACCEPT"));
  skip.addEventListener("click", () => sendFeedback("SKIP"));
  card.append(actions);
  const score = result.candidates.find((candidate) => candidate.rank === 1)?.scores;
  if (score)
    addText(
      card,
      "small",
      "价值 " +
        score.value.toFixed(2) +
        " · 适配 " +
        score.fit.toFixed(2) +
        " · 紧迫 " +
        score.urgency.toFixed(2) +
        " · 阻力 " +
        score.friction.toFixed(2),
      "score-line",
    );
  host.append(card);
}

async function sendFeedback(eventType) {
  if (!activeSessionId || !currentTargetId || feedbackPending) return;
  feedbackPending = true;
  const targetId = currentTargetId;
  try {
    await request("/v1/now/sessions/" + activeSessionId + "/feedback", {
      method: "POST",
      headers: { "X-Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ clientEventId: crypto.randomUUID(), eventType }),
    });
    if (eventType === "ACCEPT") {
      byId("recommendation").replaceChildren();
      addText(byId("recommendation"), "p", "记下了，按自己的节奏开始吧。", "quiet-note");
    } else {
      excludedObjectIds.add(targetId);
      await getRecommendation([...excludedObjectIds].slice(-100));
    }
  } catch (error) {
    addText(byId("recommendation"), "p", error.message, "error-note");
  } finally {
    feedbackPending = false;
  }
}

async function getRecommendation(excludeObjectIds = []) {
  const context = {};
  const minutes = byId("minutes").value;
  const mood = byId("mood").value;
  if (minutes) context.availableMinutes = Number(minutes);
  if (mood) context.mood = mood;
  context.willingToGoOut = byId("go-out").checked;
  const result = await request("/v1/now/sessions", {
    method: "POST",
    headers: { "X-Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ context, excludeObjectIds }),
  });
  renderRecommendation(result);
}

byId("context-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  excludedObjectIds.clear();
  try {
    await getRecommendation();
  } catch (error) {
    byId("recommendation").replaceChildren();
    addText(byId("recommendation"), "p", error.message, "error-note");
  }
});

async function refreshLife() {
  renderLife(await request("/v1/life"));
}

async function refreshCaptures() {
  const items = await request("/v1/captures");
  byId("capture-list").replaceChildren();
  if (!items.length) addText(byId("capture-list"), "div", "还没有输入记录。", "empty");
  for (const capture of items) renderCapture(capture);
}

async function refreshAll() {
  try {
    await Promise.all([refreshLife(), refreshCaptures()]);
  } catch (error) {
    setSessionLabel(error.message);
  }
}

updateLoginState();
