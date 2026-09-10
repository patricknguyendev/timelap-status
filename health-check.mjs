import { pathToFileURL } from "node:url";

const CANONICAL_ORIGIN = "https://www.timelap.app";
const MAX_RESPONSE_BYTES = 512;
const REQUEST_TIMEOUT_MS = 8_000;
const RELEASE_ID_PATTERN = /^rel_[0-9a-f]{40}$/;

export async function verifyProductionHealth({
  fetchImpl = globalThis.fetch,
  origin = CANONICAL_ORIGIN,
} = {}) {
  if (origin !== CANONICAL_ORIGIN || typeof fetchImpl !== "function") {
    throw checkError("production_monitor_configuration_invalid");
  }

  const [home, health, release] = await Promise.all([
    request(fetchImpl, `${origin}/`, "text/html", false),
    request(fetchImpl, `${origin}/api/health`, "application/json"),
    request(fetchImpl, `${origin}/api/release`, "application/json"),
  ]);

  if (home.contentType !== "text/html") {
    throw checkError("production_home_contract_invalid");
  }

  if (health.contentType !== "application/json") {
    throw checkError("production_health_contract_invalid");
  }
  const healthPayload = strictJson(health.body, "production_health_contract_invalid");
  if (!exactKeys(healthPayload, ["mode", "schemaVersion"])
    || healthPayload.schemaVersion !== 1
    || healthPayload.mode !== "operational") {
    throw checkError(
      isIncidentMode(healthPayload?.mode)
        ? "production_health_incident_active"
        : "production_health_contract_invalid",
    );
  }

  if (release.contentType !== "application/json") {
    throw checkError("production_release_contract_invalid");
  }
  const releasePayload = strictJson(release.body, "production_release_contract_invalid");
  if (!exactKeys(releasePayload, ["channel", "releaseId", "schemaVersion"])
    || releasePayload.schemaVersion !== 1
    || releasePayload.channel !== "production"
    || typeof releasePayload.releaseId !== "string"
    || !RELEASE_ID_PATTERN.test(releasePayload.releaseId)) {
    throw checkError("production_release_contract_invalid");
  }

  return Object.freeze({
    status: "operational",
    releaseId: releasePayload.releaseId,
  });
}

async function request(fetchImpl, url, accept, readBody = true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: accept },
      signal: controller.signal,
    });
    if (!response || response.status !== 200 || !response.ok || response.redirected) {
      throw checkError("production_endpoint_unavailable");
    }
    const finalUrl = new URL(response.url);
    if (finalUrl.origin !== CANONICAL_ORIGIN || finalUrl.username || finalUrl.password) {
      throw checkError("production_endpoint_origin_invalid");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
    if (!readBody) {
      await response.body?.cancel();
      return { contentType, body: "" };
    }
    const body = await boundedText(response);
    return { contentType, body };
  } catch (error) {
    if (error instanceof Error && /^production_[a-z_]+$/.test(error.message)) throw error;
    throw checkError("production_endpoint_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedText(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw checkError("production_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw checkError("production_endpoint_unavailable");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw checkError("production_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw checkError("production_endpoint_unavailable");
  }
}

function strictJson(body, errorCode) {
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw checkError(errorCode);
  }
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function isIncidentMode(value) {
  return value === "degraded" || value === "maintenance" || value === "read_only";
}

function checkError(code) {
  return new Error(code);
}

async function main() {
  try {
    const result = await verifyProductionHealth();
    process.stdout.write(`production_health_ok:${result.releaseId}\n`);
  } catch (error) {
    const code = error instanceof Error && /^production_[a-z_]+$/.test(error.message)
      ? error.message
      : "production_monitor_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
