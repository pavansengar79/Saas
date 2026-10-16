const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const User = require("./models/user.model");
const Employee = require("../employee/models/employee.model");
const AuditLog = require("../../models/auditLog.model");
const { googleCallback } = require("./auth.controller");

test("Google sign-in sends new emails to registration and only authenticates active accounts", async () => {
  const originalFindOne = User.findOne;
  const originalEmployeeFindOne = Employee.findOne;
  const originalAuditCreate = AuditLog.create;
  const originalSecret = process.env.JWT_SECRET;
  const originalOrigin = process.env.GOOGLE_FRONTEND_REDIRECT_URI;
  const callbackUrl = "https://hrms.example.com/auth/google/callback";
  const redirects = [];
  const response = { redirect: location => redirects.push(new URL(location)) };
  const request = { query: { state: callbackUrl }, ip: "127.0.0.1", get: () => "test" };

  try {
    process.env.JWT_SECRET = "google-callback-test-secret";
    process.env.GOOGLE_FRONTEND_REDIRECT_URI = callbackUrl;
    await googleCallback({ ...request, user: { isNewUser: true, email: "new@example.com", name: "New User" } }, response);
    assert.equal(redirects[0].pathname, "/auth/google/callback");
    assert.equal(new URLSearchParams(redirects[0].hash.slice(1)).get("newUser"), "true");
    assert.equal(new URLSearchParams(redirects[0].hash.slice(1)).get("email"), "new@example.com");
    assert.equal(new URLSearchParams(redirects[0].hash.slice(1)).has("token"), false);

    let currentUser = {
      _id: "user-id", email: "existing@example.com", name: "Existing User", status: "ACTIVE",
      org_id: "org-id", roleId: { _id: "role-id", slug: "admin", level: "org" }, is_first_login: false
    };
    User.findOne = () => ({ populate: async () => currentUser });
    Employee.findOne = () => ({ select: () => ({ lean: async () => null }) });
    AuditLog.create = async () => ({});

    await googleCallback({ ...request, user: { userId: "user-id", googleId: "google-id" } }, response);
    const activeParams = new URLSearchParams(redirects[1].hash.slice(1));
    assert.equal(redirects[1].search, "");
    assert.equal(activeParams.get("isOnboardingComplete"), "true");
    assert.equal(jwt.verify(activeParams.get("token"), process.env.JWT_SECRET).userId, "user-id");

    currentUser = { ...currentUser, status: "INACTIVE" };
    await googleCallback({ ...request, user: { userId: "user-id", googleId: "google-id" } }, response);
    const inactiveParams = new URLSearchParams(redirects[2].hash.slice(1));
    assert.equal(inactiveParams.has("token"), false);
    assert.match(inactiveParams.get("error"), /not active/);
  } finally {
    User.findOne = originalFindOne;
    Employee.findOne = originalEmployeeFindOne;
    AuditLog.create = originalAuditCreate;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    if (originalOrigin === undefined) delete process.env.GOOGLE_FRONTEND_REDIRECT_URI;
    else process.env.GOOGLE_FRONTEND_REDIRECT_URI = originalOrigin;
  }
});