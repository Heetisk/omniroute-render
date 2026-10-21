/**
 * render-api.mjs — thin client for the Render REST API.
 *
 * Used by tools/upload-secrets.mjs and tools/create-service.mjs.
 *
 * Authentication: a Render API key, read from the RENDER_API_KEY environment
 * variable. Never hardcode it, never commit it, never pass it as an
 * argument (it would land in the shell history).
 *
 * Docs: https://api-docs.render.com/
 */

const BASE = "https://api.render.com/v1";

export class RenderApiError extends Error {
  constructor(status, body, method, path) {
    super(`Render API ${method} ${path} -> ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "RenderApiError";
    this.status = status;
    this.body = body;
  }
}

export function getApiKey() {
  const key = process.env.RENDER_API_KEY;
  if (!key || !key.trim()) {
    throw new Error(
      "RENDER_API_KEY is not set.\n" +
        "Create a key at https://dashboard.render.com/account/api-keys and export it:\n" +
        "  $env:RENDER_API_KEY = 'rnd_...'\n" +
        "(PowerShell)  or  export RENDER_API_KEY=rnd_...  (bash)"
    );
  }
  return key.trim();
}

export async function renderRequest(method, path, { body, apiKey } = {}) {
  const key = apiKey ?? getApiKey();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) throw new RenderApiError(res.status, parsed, method, path);
  return parsed;
}

export const get = (path, opts) => renderRequest("GET", path, opts);
export const post = (path, body, opts) => renderRequest("POST", path, { ...opts, body });
export const put = (path, body, opts) => renderRequest("PUT", path, { ...opts, body });
export const del = (path, opts) => renderRequest("DELETE", path, opts);

/** List every workspace the key can see. */
export const listWorkspaces = () => get("/workspaces");

/** List the owners (accounts/orgs) available to the key. */
export const listOwners = () => get("/owners");

/**
 * Render's list endpoints return `[{ cursor, service }]` (or
 * `[{ cursor, owner }]`) rather than bare objects, so unwrap them.
 */
export function unwrapList(payload, key) {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((entry) => (entry && typeof entry === "object" && key in entry ? entry[key] : entry))
    .filter(Boolean);
}

/** The owner id for the first (usually only) available owner. */
export async function firstOwnerId() {
  const owners = unwrapList(await listOwners(), "owner");
  if (!owners.length) throw new Error("This API key has no accessible Render owners.");
  return owners[0].id;
}

/**
 * Find a web service by name, or return null.
 * @param {string} name
 * @param {string} [ownerId] restrict to one owner
 */
export async function findWebService(name, ownerId) {
  const query = new URLSearchParams({ type: "web_service" });
  if (ownerId) query.set("ownerId", ownerId);
  const services = unwrapList(await get(`/services?${query.toString()}`), "service");
  return services.find((s) => s?.name === name) ?? null;
}

/** List every service visible to the key. */
export async function listServices(ownerId) {
  const query = new URLSearchParams();
  if (ownerId) query.set("ownerId", ownerId);
  return unwrapList(await get(`/services?${query.toString()}`), "service");
}

/** Create a web service. */
export function createWebService(payload) {
  return post("/services", payload);
}

/** Set (replace) the environment variables of a service. */
export function updateEnvVars(serviceId, envVars) {
  return put(`/services/${serviceId}/env-vars`, envVars);
}

/**
 * Add or replace a secret file.
 * PUT /services/{serviceId}/secret-files/{envVarKey}  body: { "content": "..." }
 */
export function putSecretFile(serviceId, filename, content) {
  return put(`/services/${serviceId}/secret-files/${encodeURIComponent(filename)}`, { content });
}

/** List the secret files currently set on a service. */
export function listSecretFiles(serviceId) {
  return get(`/services/${serviceId}/secret-files`);
}

/** List a service's env vars (secret values are not returned). */
export function listEnvVars(serviceId) {
  return get(`/services/${serviceId}/env-vars`);
}

/**
 * Trigger a deploy of a service.
 *
 * The API rejects `clearCache` as a boolean and rejects a body it cannot
 * parse, so an empty body is the safe form. `clearCache` is not needed for
 * this deploy: the seed lives in a secret file, not in a build cache.
 */
export function triggerDeploy(serviceId, { clearCache } = {}) {
  return post(`/services/${serviceId}/deploys`, {});
}

/** Get a deploy by id. */
export function getDeploy(serviceId, deployId) {
  return get(`/services/${serviceId}/deploys/${deployId}`);
}
