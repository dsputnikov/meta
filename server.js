const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");

const MASTER_URL = "https://cdn.rage.mp/master/";
const DATA_FILE = path.join(__dirname, "data.json");
const PORT = process.env.PORT || 5173;

const CONFIG = {
  servers: [
    { id: "s1.meta-rp.com:22005", useMasterList: true },
    {
      id: "s1.metarp.net:22005",
      useMasterList: false,
      statusUrl: "http://s1.metarp.net:22010/status",
      statusHeaders: { "x-api-key": "replace-with-your-key" },
    },
  ],
  pollMs: 60000,
  historyDays: null,
  statusTimeoutMs: 4000,
};

function createDefaultState() {
  const nowIso = new Date().toISOString();
  const servers = {};
  CONFIG.servers.forEach((server) => {
    const id = server.id;
    servers[id] = {
      id,
      status: "unknown",
      current: { players: 0, ts: nowIso },
      avg: { players: 0, ts: nowIso },
      max: { players: 0, ts: nowIso },
      history: [],
    };
  });
  return { updatedAt: nowIso, servers };
}

function readState() {
  if (!fs.existsSync(DATA_FILE)) {
    return createDefaultState();
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") {
      return createDefaultState();
    }
    return data;
  } catch (error) {
    console.warn("Failed to read data.json, creating a new file.", error);
    return createDefaultState();
  }
}

function writeState(state) {
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function fetchMasterList() {
  return new Promise((resolve, reject) => {
    https
      .get(MASTER_URL, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Master list status: ${res.statusCode}`));
          return;
        }
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

async function fetchStatusUrl(url, headers) {
  if (!url) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.statusTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "meta-monitoring", ...(headers || {}) },
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractPlayers(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (Number.isFinite(payload.players)) {
    return payload.players;
  }
  if (
    payload.current &&
    typeof payload.current === "object" &&
    Number.isFinite(payload.current.players)
  ) {
    return payload.current.players;
  }
  if (
    payload.data &&
    typeof payload.data === "object" &&
    Number.isFinite(payload.data.players)
  ) {
    return payload.data.players;
  }
  return null;
}

async function fetchCustomStatus() {
  const result = {};
  for (const server of CONFIG.servers) {
    if (!server.statusUrl) {
      continue;
    }
    const payload = await fetchStatusUrl(
      server.statusUrl,
      server.statusHeaders
    );
    const players = extractPlayers(payload);
    if (Number.isFinite(players)) {
      result[server.id] = { players, online: true };
    }
  }
  return result;
}

function ensureServer(state, id) {
  if (!state.servers[id]) {
    state.servers[id] = {
      id,
      status: "unknown",
      current: { players: 0, ts: new Date().toISOString() },
      avg: { players: 0, ts: new Date().toISOString() },
      max: { players: 0, ts: new Date().toISOString() },
      history: [],
    };
  }
  return state.servers[id];
}

function updateState(state, masterList, customStatus) {
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoff =
    Number.isFinite(CONFIG.historyDays) && CONFIG.historyDays > 0
      ? now.getTime() - CONFIG.historyDays * 24 * 60 * 60 * 1000
      : null;

  CONFIG.servers.forEach((server) => {
    const id = server.id;
    const record = ensureServer(state, id);
    if (!Array.isArray(record.history)) {
      record.history = [];
    }
    const override = customStatus[id];
    let players = null;
    let isOnline = false;

    if (override && Number.isFinite(override.players)) {
      players = Math.max(0, Math.floor(override.players));
      isOnline = override.online ?? true;
    } else if (server.useMasterList) {
      const masterEntry = masterList[id];
      isOnline =
        masterEntry && Number.isFinite(masterEntry.players);
      players = isOnline ? masterEntry.players : 0;
    } else {
      players = 0;
      isOnline = false;
    }

    record.history.push({ ts: nowIso, players });
    if (cutoff !== null) {
      record.history = record.history.filter(
        (sample) => Date.parse(sample.ts) >= cutoff
      );
    }

    const total = record.history.reduce(
      (sum, sample) => sum + sample.players,
      0
    );
    const avgPlayers = record.history.length
      ? Math.round(total / record.history.length)
      : 0;

    let maxSample = { players: 0, ts: nowIso };
    record.history.forEach((sample) => {
      if (sample.players >= maxSample.players) {
        maxSample = sample;
      }
    });

    record.status = isOnline ? "online" : "offline";
    record.current = { players, ts: nowIso };
    record.avg = { players: avgPlayers, ts: nowIso };
    record.max = { players: maxSample.players, ts: maxSample.ts };
  });

  state.updatedAt = nowIso;
}

function buildResponse(state) {
  const servers = {};
  CONFIG.servers.forEach((server) => {
    const id = server.id;
    const record = ensureServer(state, id);
    servers[id] = {
      id: record.id,
      status: record.status,
      current: record.current,
      avg: record.avg,
      max: record.max,
      history: record.history,
    };
  });
  return { updatedAt: state.updatedAt, servers };
}

async function poll(state) {
  try {
    const masterList = await fetchMasterList();
    const customStatus = await fetchCustomStatus();
    updateState(state, masterList, customStatus);
    writeState(state);
  } catch (error) {
    console.warn("Failed to update monitoring data.", error);
  }
}

const app = express();
const state = readState();

app.get("/api/servers", (req, res) => {
  res.json(buildResponse(state));
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Monitoring server listening on http://localhost:${PORT}`);
});

poll(state);
setInterval(() => poll(state), CONFIG.pollMs);
