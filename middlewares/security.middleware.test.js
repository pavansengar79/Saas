const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const securityMiddleware = require("./security.middleware");

const ENV_KEYS = ["FRONTEND_URL", "FRONTEND_URLS", "GOOGLE_FRONTEND_REDIRECT_URI"];

const withEnv = async (values, fn) => {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

const startApp = () => {
  const app = express();
  securityMiddleware(app);
  app.get("/ping", (req, res) => res.json({ ok: true }));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
};

const request = async (server, { method = "GET", origin } = {}) => {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (method === "OPTIONS") {
    headers["Access-Control-Request-Method"] = "POST";
    headers["Access-Control-Request-Headers"] = "authorization,content-type";
  }
  const res = await fetch(`http://127.0.0.1:${server.address().port}/ping`, { method, headers });
  return { status: res.status, allowOrigin: res.headers.get("access-control-allow-origin") };
};

test("getAllowedOrigins reads FRONTEND_URL, FRONTEND_URLS and GOOGLE_FRONTEND_REDIRECT_URI", () =>
  withEnv(
    {
      FRONTEND_URL: "https://hrms.example.com/",
      FRONTEND_URLS: " https://a.example.com , https://hrms.example.com,not-a-url",
      GOOGLE_FRONTEND_REDIRECT_URI: "https://b.example.com/auth/google/callback"
    },
    () => {
      assert.deepEqual(securityMiddleware.getAllowedOrigins(), [
        "https://hrms.example.com",
        "https://a.example.com",
        "https://b.example.com"
      ]);
    }
  ));

test("CORS allows the frontend origin and blocks other sites", () =>
  withEnv({ FRONTEND_URL: "https://hrms.example.com" }, async () => {
    const server = await startApp();
    try {
      const ok = await request(server, { origin: "https://hrms.example.com" });
      assert.equal(ok.status, 200);
      assert.equal(ok.allowOrigin, "https://hrms.example.com");

      const preflight = await request(server, { method: "OPTIONS", origin: "https://hrms.example.com" });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.allowOrigin, "https://hrms.example.com");

      const evil = await request(server, { origin: "https://evil.example.net" });
      assert.equal(evil.allowOrigin, null);

      const noOrigin = await request(server);
      assert.equal(noOrigin.status, 200);
    } finally {
      server.close();
    }
  }));

test("CORS never falls back to * when no frontend URL is set", () =>
  withEnv({}, async () => {
    const server = await startApp();
    try {
      const res = await request(server, { origin: "https://evil.example.net" });
      assert.equal(res.allowOrigin, null);
      const noOrigin = await request(server);
      assert.equal(noOrigin.status, 200);
    } finally {
      server.close();
    }
  }));