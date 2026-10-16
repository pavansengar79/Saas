const { test } = require("node:test");
const assert = require("node:assert/strict");
const User = require("../modules/auth/models/user.model");

test("Google strategy matches normalized nondeleted email without reactivating an account", async () => {
  const originalFindOne = User.findOne;
  const previousClientId = process.env.GOOGLE_CLIENT_ID;
  const previousClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const previousRedirect = process.env.GOOGLE_REDIRECT_URI;

  try {
    process.env.GOOGLE_CLIENT_ID = "strategy-test-id";
    process.env.GOOGLE_CLIENT_SECRET = "strategy-test-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:5000/api/v1/auth/google/callback";
    const passport = require("./passport");
    const verify = passport._strategy("google")._verify;
    const profile = { id: "google-id", emails: [{ value: " Existing@Example.com " }], displayName: "Existing", _json: { email_verified: true } };
    const account = { _id: "user-id", status: "INACTIVE", googleId: undefined, save: async () => {} };
    let lookup;
    User.findOne = async filter => { lookup = filter; return account; };

    const result = await new Promise((resolve, reject) => {
      verify(null, null, profile, (error, googleUser) => error ? reject(error) : resolve(googleUser));
    });

    assert.deepEqual(lookup, { email: "existing@example.com", is_deleted: false });
    assert.equal(result.userId, "user-id");
    assert.equal(account.status, "INACTIVE");
    assert.equal(account.googleId, "google-id");

    User.findOne = async () => null;
    const unknown = await new Promise((resolve, reject) => {
      verify(null, null, profile, (error, googleUser) => error ? reject(error) : resolve(googleUser));
    });
    assert.equal(unknown.isNewUser, true);
    assert.equal(unknown.email, "existing@example.com");
  } finally {
    User.findOne = originalFindOne;
    if (previousClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousClientId;
    if (previousClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previousClientSecret;
    if (previousRedirect === undefined) delete process.env.GOOGLE_REDIRECT_URI;
    else process.env.GOOGLE_REDIRECT_URI = previousRedirect;
  }
});