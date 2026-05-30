function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secondsToMs(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : null;
}

async function retryDelayMs(response) {
  const retryAfter = secondsToMs(response.headers.get("retry-after"));
  if (retryAfter !== null) return retryAfter;

  const resetAfter = secondsToMs(response.headers.get("x-ratelimit-reset-after"));
  if (resetAfter !== null) return resetAfter;

  try {
    const data = await response.clone().json();
    const bodyRetryAfter = secondsToMs(data.retry_after);
    if (bodyRetryAfter !== null) return bodyRetryAfter;
  } catch {
    // 429s should be JSON, but fall back to a short delay if not.
  }
  return 1000;
}

export async function fetchDiscordApi(url, options = {}, settings = {}) {
  const fetchFn = settings.fetchFn ?? fetch;
  const sleepFn = settings.sleepFn ?? sleep;
  const maxRetries = Number(settings.maxRetries ?? 2);
  const maxRetryDelayMs = Number(settings.maxRetryDelayMs ?? 120000);

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchFn(url, options);
    if (response.status !== 429 || attempt >= maxRetries) return response;

    const delay = await retryDelayMs(response);
    if (delay > maxRetryDelayMs) return response;
    await sleepFn(delay);
  }
}
