"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("1.4b: gemini service loads without an API key and reports it is not configured", () => {
  const saved = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  try {
    delete require.cache[require.resolve("./gemini.service")];
    const geminiService = require("./gemini.service");
    assert.equal(geminiService.isConfigured, false);
    assert.throws(() => geminiService.getModel(), /GOOGLE_GENERATIVE_AI_API_KEY is not configured/);
  } finally {
    if (saved !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = saved;
  }
});

test("1.4b: gemini service builds the model once when a key is set", () => {
  const saved = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
  try {
    delete require.cache[require.resolve("./gemini.service")];
    const geminiService = require("./gemini.service");
    assert.equal(geminiService.isConfigured, true);
    const model = geminiService.getModel();
    assert.ok(model);
    assert.equal(geminiService.getModel(), model);
  } finally {
    if (saved === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = saved;
  }
});