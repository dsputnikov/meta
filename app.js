const refreshIntervalMs = 60000;
const maxChartPoints = 180;
const rangeConfig = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
  all: Infinity,
};
const onlineDataUrl = "/onlinedata.json";

const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const dateShortFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
});

const chartCanvas = document.querySelector(".chart-canvas");
const chartContainer = document.querySelector(".chart-blank");
const chartEmpty = document.querySelector(".chart-empty");
const chartTooltip = document.querySelector(".chart-tooltip");
const dateRangeValue = document.querySelector(".date-range span");
const tabs = Array.from(document.querySelectorAll(".tab[data-range]"));

const state = {
  payload: null,
  onlineHistory: null,
  onlineHistoryLoaded: false,
  hover: null,
  chartLayout: null,
  lastRender: null,
  activeRange: tabs.find((tab) => tab.classList.contains("is-active"))
    ?.dataset.range || "month",
};

tabs.forEach((tab) => {
  const isActive = tab.dataset.range === state.activeRange;
  tab.classList.toggle("is-active", isActive);
  tab.setAttribute("aria-pressed", isActive ? "true" : "false");
});

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return dateTimeFormatter.format(date).replace(",", "");
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return dateFormatter.format(date);
}

function formatShortDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return dateShortFormatter
    .format(date)
    .replace(".", "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatTooltipTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function setText(el, value) {
  if (!el) {
    return;
  }
  el.textContent = value;
}

function sanitizePlayers(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function convertOnlineHistory(raw) {
  if (!raw || !Array.isArray(raw.labels) || !Array.isArray(raw.datasets)) {
    return null;
  }
  const labels = raw.labels;
  const historyMap = {};
  raw.datasets.forEach((dataset) => {
    const id = dataset?.label;
    if (!id) {
      return;
    }
    const series = Array.isArray(dataset.data) ? dataset.data : [];
    const history = [];
    labels.forEach((ts, index) => {
      if (typeof ts !== "string") {
        return;
      }
      const value = index < series.length ? series[index] : 0;
      history.push({ ts, players: sanitizePlayers(value) });
    });
    historyMap[id] = history;
  });
  return historyMap;
}

function mergeHistory(primary, secondary) {
  const map = new Map();
  if (Array.isArray(primary)) {
    primary.forEach((sample) => {
      if (!sample || typeof sample.ts !== "string") {
        return;
      }
      map.set(sample.ts, {
        ts: sample.ts,
        players: sanitizePlayers(sample.players),
      });
    });
  }
  if (Array.isArray(secondary)) {
    secondary.forEach((sample) => {
      if (!sample || typeof sample.ts !== "string") {
        return;
      }
      map.set(sample.ts, {
        ts: sample.ts,
        players: sanitizePlayers(sample.players),
      });
    });
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    return 0;
  });
  return merged;
}

function getLatestHistoryTime(historyMap) {
  if (!historyMap) {
    return null;
  }
  let latest = null;
  Object.values(historyMap).forEach((history) => {
    if (!Array.isArray(history) || !history.length) {
      return;
    }
    const lastSample = history[history.length - 1];
    if (!lastSample || typeof lastSample.ts !== "string") {
      return;
    }
    const time = Date.parse(lastSample.ts);
    if (!Number.isFinite(time)) {
      return;
    }
    latest = latest === null ? time : Math.max(latest, time);
  });
  return latest;
}

function getLatestHistoryTimeFromPayload(payload) {
  if (!payload || !payload.servers) {
    return null;
  }
  let latest = null;
  Object.values(payload.servers).forEach((record) => {
    const history = record?.history;
    if (!Array.isArray(history) || !history.length) {
      return;
    }
    const lastSample = history[history.length - 1];
    if (!lastSample || typeof lastSample.ts !== "string") {
      return;
    }
    const time = Date.parse(lastSample.ts);
    if (!Number.isFinite(time)) {
      return;
    }
    latest = latest === null ? time : Math.max(latest, time);
  });
  return latest;
}

function updateStatus(el, status) {
  if (!el) {
    return;
  }
  el.classList.remove("is-online", "is-offline", "is-unknown");

  let label = "Нет данных";
  let className = "is-unknown";

  if (status === "online") {
    label = "Работает";
    className = "is-online";
  } else if (status === "offline") {
    label = "Нет ответа";
    className = "is-offline";
  }

  el.classList.add(className);
  el.textContent = label;
}

function updateCard(card, record, summary) {
  if (!card) {
    return;
  }
  const fallbackId = card.dataset.server || "-";
  const avgPlayers = summary?.avgPlayers ?? record?.avg?.players ?? 0;
  const avgTime = summary?.avgTime ?? record?.avg?.ts;
  const maxPlayers = summary?.maxPlayers ?? record?.max?.players ?? 0;
  const maxTime = summary?.maxTime ?? record?.max?.ts;
  const currentPlayers = record?.current?.players ?? 0;
  const currentTime = record?.current?.ts;

  setText(card.querySelector("[data-field='server']"), record?.id || fallbackId);
  setText(card.querySelector("[data-field='avg']"), avgPlayers);
  setText(
    card.querySelector("[data-field='avg-time']"),
    formatDateTime(avgTime)
  );
  setText(card.querySelector("[data-field='max']"), maxPlayers);
  setText(
    card.querySelector("[data-field='max-time']"),
    formatDateTime(maxTime)
  );
  setText(card.querySelector("[data-field='current']"), currentPlayers);
  setText(
    card.querySelector("[data-field='current-time']"),
    formatDateTime(currentTime)
  );
  updateStatus(card.querySelector("[data-field='status']"), record?.status);
}

async function fetchServers() {
  const response = await fetch("/api/servers", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  return response.json();
}

async function loadOnlineHistory() {
  if (state.onlineHistoryLoaded) {
    return state.onlineHistory;
  }
  state.onlineHistoryLoaded = true;
  try {
    const response = await fetch(onlineDataUrl, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const raw = await response.json();
    const historyMap = convertOnlineHistory(raw);
    if (historyMap) {
      state.onlineHistory = historyMap;
    }
    return historyMap;
  } catch (error) {
    console.warn("Не удалось загрузить историю.", error);
    return null;
  }
}

function normalizeHistory(history, minTime, maxTime) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .map((sample) => {
      const time = Date.parse(sample.ts);
      return {
        time,
        players: Number.isFinite(sample.players) ? sample.players : 0,
      };
    })
    .filter(
      (sample) =>
        Number.isFinite(sample.time) &&
        sample.time >= minTime &&
        sample.time <= maxTime
    );
}

function downsample(points, limit) {
  if (points.length <= limit) {
    return points;
  }
  const bucketSize = Math.ceil(points.length / limit);
  const result = [];
  for (let i = 0; i < points.length; i += bucketSize) {
    const bucket = points.slice(i, i + bucketSize);
    let maxPoint = bucket[0];
    bucket.forEach((point) => {
      if (point.players >= maxPoint.players) {
        maxPoint = point;
      }
    });
    result.push({ time: maxPoint.time, players: maxPoint.players });
  }
  return result;
}

function summarize(points) {
  if (!points.length) {
    return {
      avgPlayers: 0,
      avgTime: null,
      maxPlayers: 0,
      maxTime: null,
    };
  }
  const total = points.reduce((sum, point) => sum + point.players, 0);
  const avgPlayers = Math.round(total / points.length);
  let maxPoint = points[0];
  points.forEach((point) => {
    if (point.players >= maxPoint.players) {
      maxPoint = point;
    }
  });
  const lastPoint = points[points.length - 1];
  return {
    avgPlayers,
    avgTime: lastPoint.time,
    maxPlayers: maxPoint.players,
    maxTime: maxPoint.time,
  };
}

function findNearestPoint(points, targetTime) {
  if (!points.length) {
    return null;
  }
  let left = 0;
  let right = points.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (points[mid].time < targetTime) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  let index = left;
  if (index > 0) {
    const prev = points[index - 1];
    const curr = points[index];
    if (Math.abs(prev.time - targetTime) <= Math.abs(curr.time - targetTime)) {
      index = index - 1;
    }
  }
  return points[index];
}

function buildHoverData(layout, mouseX, mouseY) {
  if (!layout) {
    return null;
  }
  const { padding, rect, plotWidth, rangeStart, range } = layout;
  if (
    mouseX < padding.left ||
    mouseX > rect.width - padding.right ||
    mouseY < padding.top ||
    mouseY > rect.height - padding.bottom
  ) {
    return null;
  }
  const time =
    rangeStart + ((mouseX - padding.left) / plotWidth) * range;
  const primary =
    layout.seriesList.find((series) => series.points.length) || null;
  if (!primary) {
    return null;
  }
  const nearest = findNearestPoint(primary.points, time);
  if (!nearest) {
    return null;
  }
  const hoverTime = nearest.time;
  const x =
    padding.left + ((hoverTime - rangeStart) / range) * plotWidth;
  const points = layout.seriesList
    .map((series) => {
      const point = findNearestPoint(series.points, hoverTime);
      if (!point) {
        return null;
      }
      return {
        id: series.id,
        players: point.players,
        color: layout.colors[series.id] || "#9aa0a6",
      };
    })
    .filter(Boolean);
  return { time: hoverTime, x, points };
}

function updateTooltip(hover, layout) {
  if (!chartTooltip || !chartContainer) {
    return;
  }
  if (!hover || !layout) {
    chartTooltip.classList.remove("is-visible");
    chartTooltip.setAttribute("aria-hidden", "true");
    return;
  }
  chartTooltip.replaceChildren();

  const time = document.createElement("div");
  time.className = "tooltip-time";
  time.textContent = formatTooltipTime(hover.time);
  chartTooltip.appendChild(time);

  hover.points.forEach((point) => {
    const row = document.createElement("div");
    row.className = "tooltip-row";

    const label = document.createElement("div");
    label.className = "tooltip-label";

    const dot = document.createElement("span");
    dot.className = "tooltip-dot";
    dot.style.setProperty("--dot-color", point.color);

    const name = document.createElement("span");
    name.textContent = point.id;

    label.appendChild(dot);
    label.appendChild(name);

    const value = document.createElement("div");
    value.className = "tooltip-value";
    value.textContent = point.players.toString();

    row.appendChild(label);
    row.appendChild(value);
    chartTooltip.appendChild(row);
  });

  chartTooltip.classList.add("is-visible");
  chartTooltip.setAttribute("aria-hidden", "false");

  const containerRect = chartContainer.getBoundingClientRect();
  let left = hover.x + 12;
  let top = layout.padding.top + 10;
  chartTooltip.style.left = `${left}px`;
  chartTooltip.style.top = `${top}px`;

  const tooltipRect = chartTooltip.getBoundingClientRect();
  const maxLeft =
    containerRect.width - layout.padding.right - tooltipRect.width;
  if (left > maxLeft) {
    left = hover.x - tooltipRect.width - 12;
  }
  left = Math.max(layout.padding.left, Math.min(left, maxLeft));

  const maxTop =
    containerRect.height - layout.padding.bottom - tooltipRect.height;
  if (top > maxTop) {
    top = maxTop;
  }
  top = Math.max(layout.padding.top, top);

  chartTooltip.style.left = `${left}px`;
  chartTooltip.style.top = `${top}px`;
}

function updateDateRange(startTime, endTime) {
  if (!dateRangeValue) {
    return;
  }
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    dateRangeValue.textContent = "-";
    return;
  }
  dateRangeValue.textContent = `${formatDate(startTime)} — ${formatDate(
    endTime
  )}`;
}

function getRangeMs() {
  return rangeConfig[state.activeRange] ?? rangeConfig.month;
}

function applyRange(payload) {
  const payloadAnchor = Date.parse(payload.updatedAt);
  const historyAnchor =
    getLatestHistoryTimeFromPayload(payload) ||
    getLatestHistoryTime(state.onlineHistory);
  const nowMs = Number.isFinite(historyAnchor)
    ? historyAnchor
    : Number.isFinite(payloadAnchor)
      ? payloadAnchor
      : Date.now();
  const rangeMs = getRangeMs();
  const rangeStart = Number.isFinite(rangeMs)
    ? nowMs - rangeMs
    : 0;

  const series = {};
  let earliest = null;
  let latest = null;

  document.querySelectorAll("[data-server]").forEach((card) => {
    const id = card.dataset.server;
    const record = payload.servers?.[id];
    const points = normalizeHistory(record?.history, rangeStart, nowMs);
    const summary = summarize(points);
    updateCard(card, record, summary);

    if (points.length) {
      const firstTime = points[0].time;
      const lastTime = points[points.length - 1].time;
      earliest = earliest === null ? firstTime : Math.min(earliest, firstTime);
      latest = latest === null ? lastTime : Math.max(latest, lastTime);
    }

    series[id] = downsample(points, maxChartPoints);
  });

  if (earliest === null || latest === null) {
    updateDateRange(null, null);
  } else {
    updateDateRange(earliest, latest);
  }
  const chartStart = earliest !== null ? Math.max(rangeStart, earliest) : rangeStart;
  const chartEnd = latest ?? nowMs;
  renderChart(series, chartStart, chartEnd);
}

function formatYAxisLabel(value) {
  if (value >= 1000) {
    const thousands = value / 1000;
    const label = Number.isInteger(thousands)
      ? thousands.toString()
      : thousands.toFixed(1).replace(".0", "");
    return `${label} тыс.`;
  }
  return value.toString();
}

function getYAxisScale(maxValue) {
  const steps = 4;
  const minStep = 100;
  const safeMax = Math.max(1, maxValue);
  let step = Math.ceil(safeMax / steps / minStep) * minStep;
  const niceSteps = [50, 100, 200, 250, 500, 1000, 2000, 5000];
  step = niceSteps.find((value) => value >= step) || step;
  const max = step * steps;
  const ticks = [];
  for (let i = 0; i <= steps; i += 1) {
    ticks.push(i * step);
  }
  return { step, max, ticks };
}

function toRgba(color, alpha) {
  if (!color) {
    return `rgba(255, 255, 255, ${alpha})`;
  }
  const rgbMatch = color
    .replace(/\s+/g, "")
    .match(/^rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)$/i);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (color.startsWith("#")) {
    const normalized = color.replace("#", "");
    if (normalized.length === 6) {
      const r = parseInt(normalized.slice(0, 2), 16);
      const g = parseInt(normalized.slice(2, 4), 16);
      const b = parseInt(normalized.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }
  return `rgba(255, 255, 255, ${alpha})`;
}

function buildTimeTicks(start, end, count) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || count < 2) {
    return [];
  }
  const span = end - start;
  if (span <= 0) {
    return [start];
  }
  const ticks = [];
  const step = span / (count - 1);
  for (let i = 0; i < count; i += 1) {
    ticks.push(start + step * i);
  }
  return ticks;
}

function renderChart(seriesMap, rangeStart, rangeEnd) {
  if (!chartCanvas) {
    return;
  }
  const rect = chartCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  chartCanvas.width = Math.round(rect.width * dpr);
  chartCanvas.height = Math.round(rect.height * dpr);
  const ctx = chartCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const seriesList = Object.entries(seriesMap).map(([id, points]) => ({
    id,
    points,
  }));
  const totalPoints = seriesList.reduce(
    (sum, series) => sum + series.points.length,
    0
  );
  const hasRenderable = seriesList.some(
    (series) => series.points.length > 0
  );

  state.lastRender = { seriesMap, rangeStart, rangeEnd };

  if (chartEmpty) {
    chartEmpty.style.display = hasRenderable ? "none" : "block";
  }

  if (!hasRenderable) {
    state.chartLayout = null;
    state.hover = null;
    updateTooltip(null, null);
    return;
  }

  const padding = {
    top: 28,
    right: 32,
    bottom: 48,
    left: 64,
  };
  const plotWidth = rect.width - padding.left - padding.right;
  const plotHeight = rect.height - padding.top - padding.bottom;
  const range = Math.max(rangeEnd - rangeStart, 1);

  let maxPlayers = 0;
  seriesList.forEach((series) => {
    series.points.forEach((point) => {
      if (point.players > maxPlayers) {
        maxPlayers = point.players;
      }
    });
  });
  const yAxis = getYAxisScale(maxPlayers);

  const styles = getComputedStyle(document.documentElement);
  const axisColor =
    styles.getPropertyValue("--text-muted").trim() || "rgba(255, 255, 255, 0.6)";

  const legendColors = {};
  document.querySelectorAll("[data-legend]").forEach((legend) => {
    const id = legend.dataset.legend;
    if (!id) {
      return;
    }
    const bg = getComputedStyle(legend).backgroundColor;
    if (bg) {
      legendColors[id] = bg;
    }
  });

  const fallbackColors = {
    "s1.meta-rp.com:22005": styles.getPropertyValue("--accent-blue").trim() ||
      "#3284ff",
    "s1.metarp.net:22005": styles.getPropertyValue("--accent-green").trim() ||
      "#1aae39",
  };
  const colors = {};
  seriesList.forEach((series) => {
    colors[series.id] =
      legendColors[series.id] ||
      fallbackColors[series.id] ||
      "#9aa0a6";
  });

  const layout = {
    rect,
    padding,
    plotWidth,
    plotHeight,
    rangeStart,
    rangeEnd,
    range,
    yMax: yAxis.max,
    seriesList,
    colors,
  };
  state.chartLayout = layout;
  if (state.hover) {
    if (state.hover.time < rangeStart || state.hover.time > rangeEnd) {
      state.hover = null;
    }
  }

  const drawX = (time) => {
    const progress = (time - rangeStart) / range;
    return padding.left + progress * plotWidth;
  };

  const drawY = (players) => {
    const ratio = players / yAxis.max;
    return padding.top + (1 - ratio) * plotHeight;
  };

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 6]);
  yAxis.ticks.forEach((value) => {
    const y = drawY(value) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(rect.width - padding.right, y);
    ctx.stroke();
  });
  ctx.restore();

  ctx.save();
  ctx.font = "500 14px 'Inter Tight', sans-serif";
  ctx.fillStyle = axisColor;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const labelIndexes = new Set();
  if (yAxis.ticks.length <= 4) {
    yAxis.ticks.forEach((_, index) => labelIndexes.add(index));
  } else {
    labelIndexes.add(0);
    labelIndexes.add(1);
    labelIndexes.add(2);
    labelIndexes.add(yAxis.ticks.length - 1);
  }
  yAxis.ticks.forEach((value, index) => {
    if (!labelIndexes.has(index)) {
      return;
    }
    ctx.fillText(formatYAxisLabel(value), 12, drawY(value));
  });
  ctx.restore();

  const tickCount = Math.max(4, Math.min(8, Math.floor(plotWidth / 120)));
  const timeTicks = buildTimeTicks(rangeStart, rangeEnd, tickCount);
  if (timeTicks.length) {
    ctx.save();
    ctx.font = "500 14px 'Inter Tight', sans-serif";
    ctx.fillStyle = axisColor;
    ctx.textBaseline = "top";
    timeTicks.forEach((time, index) => {
      const x = drawX(time);
      if (index === 0) {
        ctx.textAlign = "left";
      } else if (index === timeTicks.length - 1) {
        ctx.textAlign = "right";
      } else {
        ctx.textAlign = "center";
      }
      ctx.fillText(
        formatShortDate(time),
        x,
        rect.height - padding.bottom + 14
      );
    });
    ctx.restore();
  }

  seriesList.forEach((series) => {
    const points = series.points;
    if (!points.length) {
      return;
    }
    const color = colors[series.id] || "#9aa0a6";
    const coordinates = points.map((point) => ({
      x: drawX(point.time),
      y: drawY(point.players),
    }));

    if (coordinates.length > 1) {
      const gradient = ctx.createLinearGradient(
        0,
        padding.top,
        0,
        rect.height - padding.bottom
      );
      gradient.addColorStop(0, toRgba(color, 0.2));
      gradient.addColorStop(1, toRgba(color, 0));

      ctx.save();
      ctx.beginPath();
      coordinates.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.lineTo(
        coordinates[coordinates.length - 1].x,
        rect.height - padding.bottom
      );
      ctx.lineTo(coordinates[0].x, rect.height - padding.bottom);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      coordinates.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.restore();
    }
  });

  if (state.hover) {
    const hoverX =
      padding.left + ((state.hover.time - rangeStart) / range) * plotWidth;
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(hoverX, padding.top);
    ctx.lineTo(hoverX, rect.height - padding.bottom);
    ctx.stroke();
    ctx.restore();
  }

  updateTooltip(state.hover, layout);
}

function setActiveRange(range) {
  if (!range || range === state.activeRange) {
    return;
  }
  state.activeRange = range;
  tabs.forEach((tab) => {
    const isActive = tab.dataset.range === range;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  if (state.payload) {
    applyRange(state.payload);
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => setActiveRange(tab.dataset.range));
});

function handleChartMove(event) {
  if (!chartCanvas || !state.chartLayout || !state.lastRender) {
    return;
  }
  const rect = chartCanvas.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  const layout = { ...state.chartLayout, rect };
  state.chartLayout = layout;

  const hover = buildHoverData(layout, mouseX, mouseY);
  if (!hover) {
    if (state.hover) {
      state.hover = null;
      renderChart(
        state.lastRender.seriesMap,
        state.lastRender.rangeStart,
        state.lastRender.rangeEnd
      );
    } else {
      updateTooltip(null, layout);
    }
    return;
  }

  const sameHover = state.hover && state.hover.time === hover.time;
  state.hover = hover;
  if (sameHover) {
    updateTooltip(state.hover, layout);
  } else {
    renderChart(
      state.lastRender.seriesMap,
      state.lastRender.rangeStart,
      state.lastRender.rangeEnd
    );
  }
}

function clearChartHover() {
  if (!state.hover || !state.lastRender) {
    updateTooltip(null, state.chartLayout);
    return;
  }
  state.hover = null;
  renderChart(
    state.lastRender.seriesMap,
    state.lastRender.rangeStart,
    state.lastRender.rangeEnd
  );
}

if (chartCanvas) {
  chartCanvas.addEventListener("mousemove", handleChartMove);
  chartCanvas.addEventListener("mouseleave", clearChartHover);
}

async function refresh() {
  try {
    await loadOnlineHistory();
    const payload = await fetchServers();
    if (!payload || !payload.servers) {
      return;
    }
    if (state.onlineHistory) {
      Object.entries(state.onlineHistory).forEach(([id, history]) => {
        const record = payload.servers[id];
        if (record) {
          record.history = mergeHistory(history, record.history);
        } else {
          payload.servers[id] = {
            id,
            status: "unknown",
            current: { players: 0, ts: null },
            avg: { players: 0, ts: null },
            max: { players: 0, ts: null },
            history,
          };
        }
      });
    }
    state.payload = payload;
    applyRange(payload);
  } catch (error) {
    console.warn("Не удалось обновить данные.", error);
  }
}

window.addEventListener("resize", () => {
  if (state.payload) {
    applyRange(state.payload);
  }
});

refresh();
setInterval(refresh, refreshIntervalMs);
