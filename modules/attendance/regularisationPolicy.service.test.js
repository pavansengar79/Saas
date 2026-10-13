"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const service = require("./regularisationPolicy.service");

const policy = {
  allowedFor: ["missed_punch"],
  requestWindow: { pastDaysAllowed: 30, futureAllowed: false },
  maxRequestsPerMonth: 3,
};
const request = { type: "missed_punch", date: new Date(), attachments: [] };

test("legacy policy without document requirements permits missed punch corrections", async () => {
  const result = await service.validateRequestAgainstPolicy(policy, request, 0);

  assert.deepEqual(result, { valid: true, errors: [] });
  assert.ok(service.getAllowedRegularizationTypes(policy).includes("MISSED_PUNCH_OUT"));
});

test("policy with required documents still blocks requests without attachments", async () => {
  const result = await service.validateRequestAgainstPolicy(
    { ...policy, documentRequired: { enabled: true, forTypes: ["missed_punch"] } },
    request,
    0
  );

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /Document is mandatory/);
});