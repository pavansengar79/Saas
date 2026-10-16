const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveCallbackUrl, buildRedirect } = require("./google.redirect");

test("Google OAuth returns only to configured frontend origins", () => {
  const previousOrigin = process.env.GOOGLE_FRONTEND_REDIRECT_URI;
  const previousFrontendUrl = process.env.FRONTEND_URL;
  const previousFrontendUrls = process.env.FRONTEND_URLS;

  try {
    process.env.GOOGLE_FRONTEND_REDIRECT_URI = "https://hrms.example.com/auth/google/callback";
    delete process.env.FRONTEND_URL;
    process.env.FRONTEND_URLS = "http://localhost:3000";

    assert.equal(resolveCallbackUrl("https://hrms.example.com/other?token=stale"), "https://hrms.example.com/auth/google/callback");
    assert.equal(resolveCallbackUrl("http://localhost:3000/auth/google/callback"), "http://localhost:3000/auth/google/callback");
    assert.equal(resolveCallbackUrl("https://evil.example/path"), "https://hrms.example.com/auth/google/callback");
    assert.equal(resolveCallbackUrl("javascript:alert(1)"), "https://hrms.example.com/auth/google/callback");

    const redirect = buildRedirect(resolveCallbackUrl("https://evil.example"), { newUser: true, email: "test@example.com" });
    assert.equal(new URL(redirect).search, "");
    assert.equal(new URLSearchParams(new URL(redirect).hash.slice(1)).get("email"), "test@example.com");
  } finally {
    if (previousOrigin === undefined) delete process.env.GOOGLE_FRONTEND_REDIRECT_URI;
    else process.env.GOOGLE_FRONTEND_REDIRECT_URI = previousOrigin;
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontendUrl;
    if (previousFrontendUrls === undefined) delete process.env.FRONTEND_URLS;
    else process.env.FRONTEND_URLS = previousFrontendUrls;
  }
});