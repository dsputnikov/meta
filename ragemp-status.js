const http = require("http");

const PORT = 22010;
const API_KEY = "replace-with-your-key";

const server = http.createServer((req, res) => {
  if (req.url !== "/status") {
    res.writeHead(404);
    res.end();
    return;
  }

  const auth = req.headers["x-api-key"];
  if (API_KEY && auth !== API_KEY) {
    res.writeHead(403);
    res.end();
    return;
  }

  const payload = {
    players: typeof mp !== "undefined" ? mp.players.length : 0,
    ts: new Date().toISOString(),
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`RAGE MP status endpoint listening on ${PORT}`);
});
