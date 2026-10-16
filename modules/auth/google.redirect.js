const CALLBACK_PATH = "/auth/google/callback";

const getOrigin = value => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
};

const allowedOrigins = () => [
  process.env.GOOGLE_FRONTEND_REDIRECT_URI,
  process.env.FRONTEND_URL,
  ...(process.env.FRONTEND_URLS || "").split(",")
].map(value => getOrigin(value?.trim())).filter(Boolean);

const resolveCallbackUrl = candidate => {
  const origins = allowedOrigins();
  const origin = getOrigin(candidate);
  return `${origin && origins.includes(origin) ? origin : origins[0] || "http://localhost:3000"}${CALLBACK_PATH}`;
};

const buildRedirect = (callbackUrl, params) =>
  `${callbackUrl}#${new URLSearchParams(params).toString()}`;

module.exports = { resolveCallbackUrl, buildRedirect };