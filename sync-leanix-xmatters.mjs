#!/usr/bin/env node

/**
 * Sync SAP LeanIX Fact Sheets and relations to xMatters Services and Service Dependencies.
 *
 * Node.js 18+ required.
 *
 * This job treats LeanIX as authoritative for xMatters records managed by this sync:
 *
 *   - Creates missing xMatters Services from LeanIX Fact Sheets.
 *   - Updates xMatters Services when managed fields differ.
 *   - Deletes xMatters Services previously managed by this sync when the LeanIX Fact Sheet
 *     is gone or no longer in sync scope.
 *   - Creates missing xMatters Service Dependencies from selected LeanIX relation types.
 *   - Deletes stale xMatters Service Dependencies when the LeanIX relation no longer exists.
 *
 * Important operational model:
 *
 *   LeanIX Fact Sheet       -> xMatters Service
 *   LeanIX Relation         -> xMatters Service Dependency
 *
 * xMatters dependency direction:
 *
 *   serviceId          = the service being depended on
 *   dependentServiceId = the service that depends on serviceId
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * ---------------------------------------------------------------------------
 * EDIT THIS CONFIGURATION BLOCK
 * ---------------------------------------------------------------------------
 *
 * Keep this file secure. It contains credentials.
 */
const CONFIG = {
  leanix: {
    baseUrl: "https://LEANIX_HOSTNAME",
    apiToken: process.env.LEANIX_API_TOKEN || "REPLACE_WITH_LEANIX_API_TOKEN",
    pageSize: 500,
    relationConcurrency: 4,

    factSheetTypes: [
      "Application",
      "Interface",

    ],

    includeFactSheet: (fs) => {
      return true;
    },

 

  dependencyRules: [
  {
    type: "relConsumerApplicationToInterface",
    dependedOn: "to",
    dependent: "from",
  },
  {
    type: "relProviderApplicationToInterface",
    dependedOn: "to",
    dependent: "from",
  },
]

  },

  xmatters: {
    baseUrl: "https://XMATTERS_HOSTNAME",
    username: process.env.XMATTERS_USERNAME || "REPLACE_WITH_XMATTERS_USERNAME_OR_API_KEY_ID",
    password: process.env.XMATTERS_PASSWORD || "REPLACE_WITH_XMATTERS_PASSWORD_OR_API_KEY_SECRET",


    pageSize: 1000,

    defaultOwnerGroup: "CIO_Service_Management",

    /**
     * When enabled, the sync will use LeanIX Application.itilAssignment
     * as the preferred xMatters Service owner, but only if a matching
     * xMatters Group exists.
     *
     * If the group does not exist in xMatters, the script falls back to
     * ownerByFactSheetType/defaultOwnerGroup.
     */
    useItilAssignmentGroupAsOwner: true,

    /**
     * xMatters requires Group and Service target names to be unique.
     *
     * When enabled, if the desired Service targetName already belongs to an
     * xMatters Group, the sync appends serviceNameGroupCollisionSuffix.
     *
     * Example:
     *   SAP -> SAP [Service]
     */
    avoidGroupNameServiceNameCollisions: true,
    serviceNameGroupCollisionSuffix: " [Service]",

    serviceNamePrefix: "",
    defaultServiceType: "APPLICATION",
    defaultServiceTier: "NONE",

    ownerByFactSheetType: {
      Application: "CIO_Service_Management",
      Interface: "CIO_Service_Management",
    },

    serviceTypeByFactSheetType: {
      Application: "APPLICATION",
      BusinessCapability: "APPLICATION",
      BusinessContext: "APPLICATION",
      Process: "APPLICATION",
      Interface: "TECHNICAL",
      Provider: "TECHNICAL",
      ITComponent: "TECHNICAL",
      TechPlatform: "TECHNICAL",
      Platform: "TECHNICAL",
      TechnicalStack: "TECHNICAL",
    },

    tierByFactSheetType: {
      Application: "GOLD",
      Interface: "SILVER",
      Provider: "SILVER",
      ITComponent: "SILVER",
      TechPlatform: "SILVER",
      Platform: "SILVER",
      TechnicalStack: "SILVER",
    },
  },

  sync: {
    dryRun: true,
    allowNameMatch: true,
    deleteStaleServices: true,
    deleteStaleDependencies: true,
    maxServiceDeletes: 25,
    maxDependencyDeletes: 200,
    allowDeleteWhenNoLeanixResults: false,
    stateFile: ".leanix-xmatters-sync-state.json",
    requestTimeoutMs: 30000,
    maxRetries: 3,
    logRelationTypeSummary: true,
    relationTypeSummaryLimit: 75,
  },
};

const MANAGED_START = "--- SAP LeanIX Sync Metadata ---";
const MANAGED_END = "--- End SAP LeanIX Sync Metadata ---";

const ALL_FACTSHEETS_QUERY = `
  query AllFactSheets($first: Int!, $after: String) {
    allFactSheets(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          displayName
          type
          description
        }
      }
    }
  }
`;

const VALID_SERVICE_TYPES = new Set(["APPLICATION", "TECHNICAL"]);
const VALID_SERVICE_TIERS = new Set(["PLATINUM", "GOLD", "SILVER", "BRONZE", "NONE"]);
const ENDPOINT_SIDES = new Set(["from", "to"]);

const args = new Set(process.argv.slice(2));
const dryRunFromCli = args.has("--dry-run") ? true : args.has("--apply") ? false : undefined;

const config = {
  leanixBaseUrl: stripTrailingSlash(CONFIG.leanix.baseUrl),
  leanixApiToken: CONFIG.leanix.apiToken,
  leanixPageSize: CONFIG.leanix.pageSize,
  leanixRelationConcurrency: Math.max(CONFIG.leanix.relationConcurrency, 1),
  leanixFactSheetTypes: CONFIG.leanix.factSheetTypes,
  includeFactSheet: CONFIG.leanix.includeFactSheet,

  xmattersBaseUrl: normalizeXMattersBaseUrl(CONFIG.xmatters.baseUrl),
  //xmattersBearerToken: CONFIG.xmatters.bearerToken,
  xmattersUsername: CONFIG.xmatters.username,
  xmattersPassword: CONFIG.xmatters.password,
  xmattersPageSize: Math.min(Math.max(CONFIG.xmatters.pageSize, 1), 1000),
  xmattersDefaultOwnerGroup: CONFIG.xmatters.defaultOwnerGroup,
  useItilAssignmentGroupAsOwner: Boolean(CONFIG.xmatters.useItilAssignmentGroupAsOwner),
  avoidGroupNameServiceNameCollisions: Boolean(CONFIG.xmatters.avoidGroupNameServiceNameCollisions),
  serviceNameGroupCollisionSuffix: CONFIG.xmatters.serviceNameGroupCollisionSuffix || " [Service]",

  serviceNamePrefix: CONFIG.xmatters.serviceNamePrefix,
  defaultServiceType: CONFIG.xmatters.defaultServiceType.toUpperCase(),
  defaultServiceTier: CONFIG.xmatters.defaultServiceTier.toUpperCase(),
  ownerByFactSheetType: CONFIG.xmatters.ownerByFactSheetType,
  serviceTypeByFactSheetType: CONFIG.xmatters.serviceTypeByFactSheetType,
  tierByFactSheetType: CONFIG.xmatters.tierByFactSheetType,

  dependencyRules: CONFIG.leanix.dependencyRules,

  allowNameMatch: CONFIG.sync.allowNameMatch,
  deleteStaleServices: CONFIG.sync.deleteStaleServices,
  deleteStaleDependencies: CONFIG.sync.deleteStaleDependencies,
  maxServiceDeletes: CONFIG.sync.maxServiceDeletes,
  maxDependencyDeletes: CONFIG.sync.maxDependencyDeletes,
  allowDeleteWhenNoLeanixResults: CONFIG.sync.allowDeleteWhenNoLeanixResults,

  stateFile: CONFIG.sync.stateFile,
  dryRun: dryRunFromCli ?? CONFIG.sync.dryRun,
  requestTimeoutMs: CONFIG.sync.requestTimeoutMs,
  maxRetries: CONFIG.sync.maxRetries,

  logRelationTypeSummary: CONFIG.sync.logRelationTypeSummary,
  relationTypeSummaryLimit: CONFIG.sync.relationTypeSummaryLimit,

  currentLeanixAccessToken: null,
};

const xmattersGroupByNameCache = new Map();
const xmattersAnyGroupByNameCache = new Map();

validateConfig();

function validateConfig() {
  if (!config.leanixBaseUrl) {
    throw new Error("Set CONFIG.leanix.baseUrl.");
  }

  if (!config.leanixApiToken || config.leanixApiToken === "PASTE_LEANIX_API_KEY_HERE") {
    throw new Error("Set CONFIG.leanix.apiToken.");
  }

  if (!config.xmattersBaseUrl || config.xmattersBaseUrl.includes("YOUR_XMATTERS_INSTANCE")) {
    throw new Error("Set CONFIG.xmatters.baseUrl.");
  }

  //if (!config.xmattersBearerToken) {
    if (!config.xmattersUsername || !config.xmattersPassword) {
      throw new Error("Set either CONFIG.xmatters.bearerToken or CONFIG.xmatters.username/password.");
    }

    if (config.xmattersUsername === "YOUR_XMATTERS_USERNAME_OR_API_KEY_ID") {
      throw new Error("Set CONFIG.xmatters.username or use CONFIG.xmatters.bearerToken.");
    }

    if (config.xmattersPassword === "YOUR_XMATTERS_PASSWORD_OR_API_KEY_SECRET") {
      throw new Error("Set CONFIG.xmatters.password or use CONFIG.xmatters.bearerToken.");
    }
  //}

  if (!config.xmattersDefaultOwnerGroup) {
    throw new Error("Set CONFIG.xmatters.defaultOwnerGroup.");
  }

  if (!Array.isArray(config.leanixFactSheetTypes) || config.leanixFactSheetTypes.length === 0) {
    throw new Error("CONFIG.leanix.factSheetTypes must be a non-empty array.");
  }

  if (typeof config.includeFactSheet !== "function") {
    throw new Error("CONFIG.leanix.includeFactSheet must be a function.");
  }

  if (!VALID_SERVICE_TYPES.has(config.defaultServiceType)) {
    throw new Error(`Invalid CONFIG.xmatters.defaultServiceType: ${config.defaultServiceType}`);
  }

  if (!VALID_SERVICE_TIERS.has(config.defaultServiceTier)) {
    throw new Error(`Invalid CONFIG.xmatters.defaultServiceTier: ${config.defaultServiceTier}`);
  }

  for (const [factSheetType, serviceType] of Object.entries(config.serviceTypeByFactSheetType || {})) {
    const normalized = String(serviceType).toUpperCase();

    if (!VALID_SERVICE_TYPES.has(normalized)) {
      throw new Error(
        `Invalid serviceType mapping for ${factSheetType}: ${serviceType}. Use APPLICATION or TECHNICAL.`
      );
    }
  }

  for (const [factSheetType, serviceTier] of Object.entries(config.tierByFactSheetType || {})) {
    const normalized = String(serviceTier).toUpperCase();

    if (!VALID_SERVICE_TIERS.has(normalized)) {
      throw new Error(
        `Invalid serviceTier mapping for ${factSheetType}: ${serviceTier}. Use PLATINUM, GOLD, SILVER, BRONZE, or NONE.`
      );
    }
  }

  for (const rule of config.dependencyRules) {
    if (!rule.type) {
      throw new Error(`Every dependency rule must include type: ${JSON.stringify(rule)}`);
    }

    if (!ENDPOINT_SIDES.has(rule.dependedOn) || !ENDPOINT_SIDES.has(rule.dependent)) {
      throw new Error(
        `Dependency rule dependedOn/dependent must be "from" or "to": ${JSON.stringify(rule)}`
      );
    }

    if (rule.dependedOn === rule.dependent) {
      throw new Error(
        `Dependency rule cannot point both sides at ${rule.dependedOn}: ${JSON.stringify(rule)}`
      );
    }
  }
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeXMattersBaseUrl(value) {
  const base = stripTrailingSlash(value);
  if (!base) return "";
  return base.includes("/api/xm/") ? base : `${base}/api/xm/1`;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function truncate(value, max = 3000) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function log(message, details = undefined) {
  const ts = new Date().toISOString();

  if (details === undefined) {
    console.log(`[${ts}] ${message}`);
  } else {
    console.log(`[${ts}] ${message}`, details);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function caseInsensitiveLookup(object, key) {
  if (!object || key === undefined || key === null) return undefined;

  if (Object.prototype.hasOwnProperty.call(object, key)) {
    return object[key];
  }

  const wanted = String(key).toLowerCase();
  const found = Object.keys(object).find((k) => k.toLowerCase() === wanted);

  return found ? object[found] : undefined;
}

function sameNormalizedValue(a, b) {
  return normalizeText(a) === normalizeText(b);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sanitizeXMattersServiceName(name) {
  let sanitized = normalizeText(name);

  sanitized = sanitized
    .replaceAll("|", " - ")
    .replaceAll(",", " - ")
    .replaceAll("\t", " ")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");

  sanitized = sanitized.replace(/\s+/g, " ").trim();

  const MAX_LENGTH = 250;

  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.slice(0, MAX_LENGTH).trim();
  }

  return sanitized;
}

function buildXMattersTargetName(fs) {
  const leanixName = normalizeText(fs.displayName || fs.name || fs.id);
  return sanitizeXMattersServiceName(`${config.serviceNamePrefix}${leanixName}`);
}

function appendServiceSuffixToName(name) {
  const baseName = sanitizeXMattersServiceName(name);
  const suffix = normalizeText(config.serviceNameGroupCollisionSuffix || " [Service]");

  if (!baseName || !suffix) {
    return baseName;
  }

  if (normalizeKey(baseName).endsWith(normalizeKey(suffix))) {
    return baseName;
  }

  return sanitizeXMattersServiceName(`${baseName}${suffix}`);
}

function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers?.get?.("retry-after");

  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  return Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 250), 30000);
}

async function requestJson(url, options, expectedStatuses, label) {
  let lastError;

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      const text = await response.text();
      const body = text ? safeJsonParse(text) : null;

      if (expectedStatuses.includes(response.status)) {
        return body;
      }

      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < config.maxRetries) {
        const delay = retryDelayMs(response, attempt);
        log(`${label} returned HTTP ${response.status}; retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      throw new Error(`${label} failed with HTTP ${response.status}: ${truncate(text)}`);
    } catch (error) {
      lastError = error;

      const retryable =
        error.name === "AbortError" ||
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.cause?.code === "ECONNRESET" ||
        error.cause?.code === "ETIMEDOUT";

      if (retryable && attempt < config.maxRetries) {
        const delay = retryDelayMs(null, attempt);
        log(`${label} failed with ${error.message}; retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

function leanixTokenHeaders() {
  return {
    Authorization: `Basic ${Buffer.from(`apitoken:${config.leanixApiToken}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
}

function leanixBearerHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${config.currentLeanixAccessToken}`,
    Accept: "application/json",
    ...extra,
  };
}

function xmattersHeaders(extra = {}) {
  const headers = {
    Accept: "application/json",
    ...extra,
  };

  if (config.xmattersBearerToken) {
    headers.Authorization = `Bearer ${config.xmattersBearerToken}`;
  } else {
    headers.Authorization = `Basic ${Buffer.from(
      `${config.xmattersUsername}:${config.xmattersPassword}`
    ).toString("base64")}`;
  }

  return headers;
}

function xmattersUrl(pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  const origin = new URL(config.xmattersBaseUrl).origin;

  if (pathOrUrl.startsWith("/api/xm/")) {
    return `${origin}${pathOrUrl}`;
  }

  return `${config.xmattersBaseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

async function getLeanixAccessToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
  });

  const response = await requestJson(
    `${config.leanixBaseUrl}/services/mtm/v1/oauth2/token`,
    {
      method: "POST",
      headers: leanixTokenHeaders(),
      body,
    },
    [200],
    "LeanIX token request"
  );

  if (!response?.access_token) {
    throw new Error("LeanIX token response did not include access_token.");
  }

  config.currentLeanixAccessToken = response.access_token;
}

async function leanixGraphQL(query, variables) {
  const response = await requestJson(
    `${config.leanixBaseUrl}/services/pathfinder/v1/graphql`,
    {
      method: "POST",
      headers: leanixBearerHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        query,
        variables,
      }),
    },
    [200],
    "LeanIX GraphQL request"
  );

  if (response?.errors?.length) {
    throw new Error(`LeanIX GraphQL errors: ${JSON.stringify(response.errors, null, 2)}`);
  }
  return response.data;
}

function shouldIncludeFactSheet(fs) {
  try {
    return Boolean(config.includeFactSheet(fs));
  } catch (error) {
    throw new Error(
      `CONFIG.leanix.includeFactSheet failed for Fact Sheet ${fs?.id || "unknown"}: ${error.message}`
    );
  }
}

async function fetchLeanixFactSheetDetail(factSheetId) {
  const url = `${config.leanixBaseUrl}/services/pathfinder/v1/factSheets/${encodeURIComponent(
    factSheetId
  )}`;

  const response = await requestJson(
    url,
    {
      method: "GET",
      headers: leanixBearerHeaders(),
    },
    [200],
    "LeanIX GET Fact Sheet detail"
  );

  return response?.data || response;
}

function shouldFetchDetailedLeanixFactSheet(fs) {
  return (
    config.useItilAssignmentGroupAsOwner &&
    String(fs?.type || "").toLowerCase() === "application" &&
    Boolean(fs?.id)
  );
}

async function enrichLeanixFactSheetsWithDetails(factSheets) {
  const factSheetsToFetch = factSheets.filter(shouldFetchDetailedLeanixFactSheet);

  if (factSheetsToFetch.length === 0) {
    return factSheets;
  }

  log("Fetching detailed LeanIX Application Fact Sheets for ITIL custom fields", {
    factSheetsToFetch: factSheetsToFetch.length,
  });

  const detailedFactSheets = await mapLimit(
    factSheetsToFetch,
    config.leanixRelationConcurrency,
    async (fs, index) => {
      const detail = await fetchLeanixFactSheetDetail(fs.id);
      const merged = {
        ...fs,
        ...detail,
        id: detail?.id || fs.id,
        name: detail?.name || fs.name,
        displayName: detail?.displayName || fs.displayName,
        type: detail?.type || fs.type,
        description:
          detail?.description !== undefined && detail?.description !== null
            ? detail.description
            : fs.description,
      };

      const itilAssignmentGroup = getItilAssignmentGroup(merged);

      log(`Read LeanIX Fact Sheet detail ${index + 1}/${factSheetsToFetch.length}: ${merged.displayName || merged.name || merged.id}`, {
        leanixId: merged.id,
        itilAssignmentGroup: itilAssignmentGroup || "(blank)",
      });

      return merged;
    }
  );

  const detailById = new Map(
    detailedFactSheets
      .filter((fs) => fs?.id)
      .map((fs) => [fs.id, fs])
  );

  const enriched = factSheets.map((fs) => detailById.get(fs.id) || fs);

  const factSheetsWithItilAssignment = enriched
    .filter((fs) => getItilAssignmentGroup(fs))
    .map((fs) => ({
      leanixId: fs.id,
      name: fs.displayName || fs.name || fs.id,
      itilAssignmentGroup: getItilAssignmentGroup(fs),
    }));

  log("LeanIX ITIL Assignment values found after detail fetch", {
    count: factSheetsWithItilAssignment.length,
    sample: factSheetsWithItilAssignment.slice(0, 50),
  });

  return enriched;
}

async function fetchAllLeanixFactSheets() {
  const all = [];
  let after = null;
  let page = 0;

  do {
    page += 1;

    const data = await leanixGraphQL(ALL_FACTSHEETS_QUERY, {
      first: config.leanixPageSize,
      after,
    });

    const connection = data?.allFactSheets;

    if (!connection) {
      throw new Error("LeanIX response did not include allFactSheets.");
    }

    const nodes = (connection.edges || [])
      .map((edge) => edge.node)
      .filter(Boolean);

    all.push(...nodes);

    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;

    log(`Read LeanIX page ${page}; cumulative Fact Sheets: ${all.length}`);
  } while (after);

  const allowedTypes = new Set(
    config.leanixFactSheetTypes.map((type) => String(type).toLowerCase())
  );

  const typeFiltered = allowedTypes.has("*")
    ? all
    : all.filter((fs) => allowedTypes.has(String(fs.type || "").toLowerCase()));

  const detailedTypeFiltered = await enrichLeanixFactSheetsWithDetails(typeFiltered);
  const customFiltered = detailedTypeFiltered.filter(shouldIncludeFactSheet);

  log(`Filtered LeanIX Fact Sheets: ${customFiltered.length} of ${all.length}`, {
    typeFiltered: typeFiltered.length,
    includedTypes: config.leanixFactSheetTypes,
    detailFetchedApplications: detailedTypeFiltered.filter((fs) => Array.isArray(fs.fields)).length,
  });

  return customFiltered;
}

function extractPageData(page) {
  if (Array.isArray(page)) return page;
  if (Array.isArray(page?.data)) return page.data;
  if (Array.isArray(page?.items)) return page.items;
  if (Array.isArray(page?.relations)) return page.relations;
  if (Array.isArray(page?.content)) return page.content;
  if (Array.isArray(page?._embedded?.data)) return page._embedded.data;
  if (Array.isArray(page?._embedded?.relations)) return page._embedded.relations;

  return [];
}

async function fetchPaginatedXMatters(pathName, label) {
  const all = [];
  let offset = 0;
  let nextUrl = xmattersUrl(`${pathName}?limit=${config.xmattersPageSize}&offset=0`);

  while (nextUrl) {
    const page = await requestJson(
      nextUrl,
      {
        method: "GET",
        headers: xmattersHeaders(),
      },
      [200],
      label
    );

    const data = extractPageData(page);
    all.push(...data);

    if (page?.links?.next) {
      nextUrl = xmattersUrl(page.links.next);
    } else if (Number.isFinite(page?.total) && all.length < page.total) {
      offset += config.xmattersPageSize;
      nextUrl = xmattersUrl(`${pathName}?limit=${config.xmattersPageSize}&offset=${offset}`);
    } else {
      nextUrl = null;
    }

    log(`Read ${label}; cumulative records: ${all.length}`);
  }

  return all;
}

async function fetchAllXMattersServices() {
  return fetchPaginatedXMatters("/services", "xMatters GET /services");
}

async function fetchAllXMattersDependencies() {
  return fetchPaginatedXMatters("/service-dependencies", "xMatters GET /service-dependencies");
}

async function fetchLeanixRelationsForFactSheet(factSheetId) {
  const url = `${config.leanixBaseUrl}/services/pathfinder/v1/factSheets/${encodeURIComponent(
    factSheetId
  )}/relations`;

  const response = await requestJson(
    url,
    {
      method: "GET",
      headers: leanixBearerHeaders(),
    },
    [200],
    "LeanIX GET Fact Sheet relations"
  );

  return extractPageData(response);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(limit, items.length),
      },
      runWorker
    )
  );

  return results;
}

async function fetchLeanixRelationsForDesiredServices(desiredServices) {
  const batches = await mapLimit(
    desiredServices,
    config.leanixRelationConcurrency,
    async (desired, index) => {
      const relations = await fetchLeanixRelationsForFactSheet(desired.leanixId);

      log(
        `Read LeanIX relations ${index + 1}/${desiredServices.length}: ${desired.targetName} (${relations.length})`
      );

      return relations.map((relation) => ({
        relation,
        sourceFactSheetId: desired.leanixId,
      }));
    }
  );

  return batches.flat();
}

function extractLeanixFactSheetIdFromDescription(description) {
  const text = String(description || "");
  const match = text.match(/LeanIX Fact Sheet ID:\s*([A-Za-z0-9._:-]+)/i);

  return match?.[1] || null;
}


function normalizeGroupValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return normalizeText(value);
  }

  if (typeof value === "object") {
    return normalizeText(
      value.targetName ||
      value.displayName ||
      value.name ||
      value.fullName ||
      value.value ||
      value.label ||
      value.data?.value ||
      value.data?.keyword ||
      ""
    );
  }

  return normalizeText(value);
}

function getLeanixCustomFieldValue(fs, candidateNames) {
  const wanted = new Set(candidateNames.map((name) => String(name).toLowerCase()));

  for (const field of fs?.fields || []) {
    if (!wanted.has(String(field?.name || "").toLowerCase())) {
      continue;
    }

    const data = field.data || {};

    if (data.value !== undefined && data.value !== null) {
      return normalizeGroupValue(data.value);
    }

    if (data.keyword !== undefined && data.keyword !== null) {
      return normalizeGroupValue(data.keyword);
    }

    if (Array.isArray(data.values) && data.values.length > 0) {
      return data.values.map(normalizeGroupValue).filter(Boolean).join(", ");
    }

    if (data.externalId !== undefined && data.externalId !== null) {
      return normalizeGroupValue(data.externalId);
    }
  }

  return "";
}

function getItilAssignmentGroup(fs) {
  return normalizeGroupValue(
    fs.itilAssignment ||
      fs.itilAssignmentGroup ||
      fs.ITILAssignment ||
      fs["ITILAssignment"] ||
      fs["ITIL Assignment"] ||
      fs.data?.itilAssignment ||
      fs.data?.ITILAssignment ||
      getLeanixCustomFieldValue(fs, ["itilAssignment", "ITILAssignment", "ITIL Assignment"])
  );
}

function getItilApprovalGroup(fs) {
  return normalizeGroupValue(
    fs.itilApproval ||
      fs.itilApprovalGroup ||
      fs.ITILApproval ||
      fs["ITILApproval"] ||
      fs["ITIL Approval"] ||
      fs.data?.itilApproval ||
      fs.data?.ITILApproval ||
      getLeanixCustomFieldValue(fs, ["itilApproval", "ITILApproval", "ITIL Approval"])
  );
}

async function fetchXMattersGroupByTargetName(groupName) {
  const normalizedGroupName = normalizeGroupValue(groupName);

  if (!normalizedGroupName) {
    return null;
  }

  const cacheKey = normalizeKey(normalizedGroupName);

  if (xmattersGroupByNameCache.has(cacheKey)) {
    return xmattersGroupByNameCache.get(cacheKey);
  }

  try {
    const group = await requestJson(
      xmattersUrl(`/groups/${encodeURIComponent(normalizedGroupName)}`),
      {
        method: "GET",
        headers: xmattersHeaders(),
      },
      [200],
      "xMatters GET /groups/{groupID}"
    );

    if (group?.status && String(group.status).toUpperCase() !== "ACTIVE") {
      log("LeanIX ITIL Assignment group exists in xMatters but is not ACTIVE; falling back", {
        leanixItilAssignmentGroup: normalizedGroupName,
        xmattersGroupId: group.id,
        xmattersGroupStatus: group.status,
      });

      xmattersGroupByNameCache.set(cacheKey, null);
      return null;
    }

    xmattersGroupByNameCache.set(cacheKey, group);
    return group;
  } catch (error) {
    if (String(error.message || "").includes("HTTP 404")) {
      xmattersGroupByNameCache.set(cacheKey, null);
      return null;
    }

    throw error;
  }
}

async function fetchAnyXMattersGroupByTargetName(groupName) {
  const normalizedGroupName = normalizeGroupValue(groupName);

  if (!normalizedGroupName) {
    return null;
  }

  const cacheKey = normalizeKey(normalizedGroupName);

  if (xmattersAnyGroupByNameCache.has(cacheKey)) {
    return xmattersAnyGroupByNameCache.get(cacheKey);
  }

  try {
    const group = await requestJson(
      xmattersUrl(`/groups/${encodeURIComponent(normalizedGroupName)}`),
      {
        method: "GET",
        headers: xmattersHeaders(),
      },
      [200],
      "xMatters GET /groups/{groupID} for service-name collision check"
    );

    xmattersAnyGroupByNameCache.set(cacheKey, group || null);
    return group || null;
  } catch (error) {
    if (String(error.message || "").includes("HTTP 404")) {
      xmattersAnyGroupByNameCache.set(cacheKey, null);
      return null;
    }

    throw error;
  }
}

async function resolveItilAssignmentOwnerGroups(leanixFactSheets) {
  const ownerResolutionByLeanixId = new Map();

  if (!config.useItilAssignmentGroupAsOwner) {
    return ownerResolutionByLeanixId;
  }

  const uniqueAssignments = [
    ...new Set(
      leanixFactSheets
        .map(getItilAssignmentGroup)
        .map(normalizeGroupValue)
        .filter(Boolean)
    ),
  ];

  if (uniqueAssignments.length === 0) {
    log("No LeanIX Fact Sheets had a non-blank itilAssignment value.");
    return ownerResolutionByLeanixId;
  }

  log("Checking xMatters Groups for LeanIX itilAssignment values", {
    uniqueItilAssignmentGroups: uniqueAssignments.length,
  });

  const groupByAssignmentName = new Map();

  for (const assignmentName of uniqueAssignments) {
    const group = await fetchXMattersGroupByTargetName(assignmentName);
    groupByAssignmentName.set(normalizeKey(assignmentName), group);

    if (!group) {
      log("xMatters Group not found for LeanIX itilAssignment; using fallback owner", {
        leanixItilAssignmentGroup: assignmentName,
      });
    }
  }

  let factSheetsWithItilAssignment = 0;
  let factSheetsWithMatchedXmattersGroup = 0;
  let factSheetsUsingFallbackOwner = 0;

  for (const fs of leanixFactSheets) {
    const assignmentName = getItilAssignmentGroup(fs);

    if (!assignmentName) {
      factSheetsUsingFallbackOwner += 1;
      continue;
    }

    factSheetsWithItilAssignment += 1;

    const group = groupByAssignmentName.get(normalizeKey(assignmentName));

    if (!group?.targetName) {
      factSheetsUsingFallbackOwner += 1;
      continue;
    }

    factSheetsWithMatchedXmattersGroup += 1;

    ownerResolutionByLeanixId.set(fs.id, {
      source: "LeanIX itilAssignment",
      leanixItilAssignmentGroup: assignmentName,
      xmattersGroup: group,
    });
  }

  log("Resolved xMatters owner groups from LeanIX itilAssignment", {
    factSheetsWithItilAssignment,
    factSheetsWithMatchedXmattersGroup,
    factSheetsUsingFallbackOwner,
    unmatchedItilAssignmentGroups: uniqueAssignments
      .filter((assignmentName) => !groupByAssignmentName.get(normalizeKey(assignmentName)))
      .slice(0, 50),
  });

  return ownerResolutionByLeanixId;
}


async function resolveServiceTargetNamesAgainstXMattersGroups(leanixFactSheets) {
  const targetNameResolutionByLeanixId = new Map();

  if (!config.avoidGroupNameServiceNameCollisions) {
    return targetNameResolutionByLeanixId;
  }

  const candidateServiceNames = [
    ...new Set(
      leanixFactSheets
        .map(buildXMattersTargetName)
        .map(normalizeText)
        .filter(Boolean)
    ),
  ];

  if (candidateServiceNames.length === 0) {
    return targetNameResolutionByLeanixId;
  }

  log("Checking xMatters Groups for Service targetName collisions", {
    uniqueCandidateServiceNames: candidateServiceNames.length,
    suffix: config.serviceNameGroupCollisionSuffix,
  });

  const groupLookupResults = await mapLimit(
    candidateServiceNames,
    Math.min(config.leanixRelationConcurrency, 4),
    async (candidateServiceName) => ({
      candidateServiceName,
      group: await fetchAnyXMattersGroupByTargetName(candidateServiceName),
    })
  );

  const groupByCandidateServiceName = new Map(
    groupLookupResults.map(({ candidateServiceName, group }) => [
      normalizeKey(candidateServiceName),
      group,
    ])
  );

  for (const fs of leanixFactSheets) {
    const originalTargetName = buildXMattersTargetName(fs);

    if (!originalTargetName) {
      continue;
    }

    const matchingGroup = groupByCandidateServiceName.get(normalizeKey(originalTargetName));

    if (!matchingGroup) {
      continue;
    }

    const adjustedTargetName = appendServiceSuffixToName(originalTargetName);

    targetNameResolutionByLeanixId.set(fs.id, {
      source: "xMatters Group targetName collision",
      originalTargetName,
      adjustedTargetName,
      xmattersGroup: matchingGroup,
    });

    log("Adjusted xMatters Service targetName because a Group already uses the same name", {
      leanixId: fs.id,
      leanixType: fs.type,
      originalTargetName,
      adjustedTargetName,
      xmattersGroupId: matchingGroup.id,
      xmattersGroupStatus: matchingGroup.status || "",
    });
  }

  log("Resolved xMatters Service targetName collisions with Groups", {
    adjustedServices: targetNameResolutionByLeanixId.size,
    sample: [...targetNameResolutionByLeanixId.values()].slice(0, 50).map((item) => ({
      originalTargetName: item.originalTargetName,
      adjustedTargetName: item.adjustedTargetName,
      xmattersGroupId: item.xmattersGroup?.id,
    })),
  });

  return targetNameResolutionByLeanixId;
}

function buildLeanixDescription(fs) {
  const MAX_DESCRIPTION_LENGTH = 2000;

  const itilAssignmentGroup = getItilAssignmentGroup(fs);
  const itilApprovalGroup = getItilApprovalGroup(fs);

  const metadata = [
    MANAGED_START,
    `LeanIX Fact Sheet ID: ${fs.id}`,
    `LeanIX Fact Sheet Type: ${fs.type || ""}`,
    `LeanIX Original Fact Sheet Name: ${fs.displayName || fs.name || ""}`,
    `LeanIX ITIL Assignment Group: ${itilAssignmentGroup || ""}`,
    `LeanIX ITIL Approval Group: ${itilApprovalGroup || ""}`,
    MANAGED_END,
  ].join("\n");

  const base = normalizeText(fs.description);

  if (!base) {
    return metadata.length > MAX_DESCRIPTION_LENGTH
      ? metadata.slice(0, MAX_DESCRIPTION_LENGTH)
      : metadata;
  }

  const separator = "\n\n";
  const availableBaseLength = MAX_DESCRIPTION_LENGTH - separator.length - metadata.length;

  if (availableBaseLength <= 0) {
    return metadata.slice(0, MAX_DESCRIPTION_LENGTH);
  }

  const trimmedBase =
    base.length > availableBaseLength
      ? `${base.slice(0, Math.max(availableBaseLength - 20, 0)).trim()}... [trimmed]`
      : base;

  return `${trimmedBase}${separator}${metadata}`;
}

function mapServiceType(fs) {
  const mapped =
    caseInsensitiveLookup(config.serviceTypeByFactSheetType, fs.type) || config.defaultServiceType;

  const serviceType = String(mapped).toUpperCase();

  if (!VALID_SERVICE_TYPES.has(serviceType)) {
    throw new Error(
      `Mapped invalid xMatters serviceType "${serviceType}" for LeanIX type "${fs.type}".`
    );
  }

  return serviceType;
}

function mapServiceTier(fs) {
  const mapped =
    caseInsensitiveLookup(config.tierByFactSheetType, fs.type) || config.defaultServiceTier;

  const serviceTier = String(mapped).toUpperCase();

  if (!VALID_SERVICE_TIERS.has(serviceTier)) {
    throw new Error(
      `Mapped invalid xMatters serviceTier "${serviceTier}" for LeanIX type "${fs.type}".`
    );
  }

  return serviceTier;
}

function mapOwnerGroup(fs, ownerResolutionByLeanixId) {
  const ownerResolution = ownerResolutionByLeanixId?.get(fs.id);

  if (ownerResolution?.xmattersGroup?.targetName) {
    return ownerResolution.xmattersGroup.targetName;
  }

  return caseInsensitiveLookup(config.ownerByFactSheetType, fs.type) || config.xmattersDefaultOwnerGroup;
}

function mapServiceTargetName(fs, serviceTargetNameResolutionByLeanixId = new Map()) {
  const resolution = serviceTargetNameResolutionByLeanixId?.get(fs.id);

  if (resolution?.adjustedTargetName) {
    return resolution.adjustedTargetName;
  }

  return buildXMattersTargetName(fs);
}

function buildDesiredService(
  fs,
  ownerResolutionByLeanixId = new Map(),
  serviceTargetNameResolutionByLeanixId = new Map()
) {
  if (!fs.id) {
    throw new Error(`LeanIX Fact Sheet missing id: ${JSON.stringify(fs)}`);
  }

  const name = mapServiceTargetName(fs, serviceTargetNameResolutionByLeanixId);

  if (!name) {
    throw new Error(`Could not derive targetName for LeanIX Fact Sheet ${fs.id}.`);
  }

  return {
    leanixId: fs.id,
    leanixType: fs.type,
    targetName: name,
    body: {
      targetName: name,
      description: buildLeanixDescription(fs),
      serviceType: mapServiceType(fs),
      serviceTier: mapServiceTier(fs),
      ownedBy: {
        targetName: mapOwnerGroup(fs, ownerResolutionByLeanixId),
      },
    },
  };
}

function summarizeDesiredServiceNameCollisions(desiredServices) {
  const byName = new Map();

  for (const desired of desiredServices) {
    const key = normalizeKey(desired.targetName);

    if (!byName.has(key)) {
      byName.set(key, []);
    }

    byName.get(key).push({
      leanixId: desired.leanixId,
      leanixType: desired.leanixType,
      targetName: desired.targetName,
    });
  }

  return [...byName.values()]
    .filter((items) => items.length > 1)
    .map((items) => ({
      targetName: items[0].targetName,
      count: items.length,
      items,
    }));
}

function summarizeXMattersServiceMappingCollisions(serviceByLeanixId) {
  const byXmattersId = new Map();

  for (const [leanixId, service] of serviceByLeanixId.entries()) {
    if (!service?.id) continue;

    if (!byXmattersId.has(service.id)) {
      byXmattersId.set(service.id, []);
    }

    byXmattersId.get(service.id).push({
      leanixId,
      targetName: service.targetName,
    });
  }

  return [...byXmattersId.entries()]
    .filter(([, mappings]) => mappings.length > 1)
    .map(([xmattersServiceId, mappings]) => ({
      xmattersServiceId,
      mappedLeanixCount: mappings.length,
      mappings,
    }));
}

function indexXMattersServices(services) {
  const byId = new Map();
  const byTargetName = new Map();
  const duplicateTargetNames = new Set();
  const byLeanixId = new Map();

  for (const service of services) {
    if (service.id) {
      byId.set(service.id, service);
    }

    const nameKey = normalizeKey(service.targetName);

    if (nameKey) {
      if (byTargetName.has(nameKey)) {
        duplicateTargetNames.add(nameKey);
      } else {
        byTargetName.set(nameKey, service);
      }
    }

    const leanixId = extractLeanixFactSheetIdFromDescription(service.description);

    if (leanixId) {
      byLeanixId.set(leanixId, service);
    }
  }

  return {
    byId,
    byTargetName,
    duplicateTargetNames,
    byLeanixId,
  };
}

function findExistingService(desired, index, state) {
  const stateEntry = state.byLeanixId?.[desired.leanixId];

  if (stateEntry?.xmattersId && index.byId.has(stateEntry.xmattersId)) {
    return {
      service: index.byId.get(stateEntry.xmattersId),
      matchedBy: "state-file",
    };
  }

  if (index.byLeanixId.has(desired.leanixId)) {
    return {
      service: index.byLeanixId.get(desired.leanixId),
      matchedBy: "description-marker",
    };
  }

  if (config.allowNameMatch) {
    const nameKey = normalizeKey(desired.targetName);

    if (index.duplicateTargetNames.has(nameKey)) {
      return {
        conflict: `Multiple xMatters Services have targetName "${desired.targetName}".`,
      };
    }

    if (index.byTargetName.has(nameKey)) {
      return {
        service: index.byTargetName.get(nameKey),
        matchedBy: "targetName",
      };
    }
  }

  return null;
}

function sameOwner(currentOwnedBy, desiredOwnedBy) {
  if (!currentOwnedBy && !desiredOwnedBy) return true;
  if (!currentOwnedBy || !desiredOwnedBy) return false;

  if (currentOwnedBy.id && desiredOwnedBy.id) {
    return sameNormalizedValue(currentOwnedBy.id, desiredOwnedBy.id);
  }

  if (currentOwnedBy.targetName && desiredOwnedBy.targetName) {
    return sameNormalizedValue(currentOwnedBy.targetName, desiredOwnedBy.targetName);
  }

  return (
    sameNormalizedValue(currentOwnedBy.id, desiredOwnedBy.id) ||
    sameNormalizedValue(currentOwnedBy.targetName, desiredOwnedBy.targetName)
  );
}

function diffService(current, desiredBody) {
  const changes = {};

  for (const field of ["targetName", "description", "serviceType", "serviceTier"]) {
    if (!sameNormalizedValue(current[field], desiredBody[field])) {
      changes[field] = desiredBody[field];
    }
  }

  if (!sameOwner(current.ownedBy, desiredBody.ownedBy)) {
    changes.ownedBy = desiredBody.ownedBy;
  }

  return changes;
}

async function postXMattersService(payload) {
  return requestJson(
    xmattersUrl("/services"),
    {
      method: "POST",
      headers: xmattersHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(payload),
    },
    [200, 201],
    "xMatters POST /services"
  );
}

async function deleteXMattersService(serviceId) {
  return requestJson(
    xmattersUrl(`/services/${encodeURIComponent(serviceId)}`),
    {
      method: "DELETE",
      headers: xmattersHeaders(),
    },
    [200, 202, 204, 404],
    "xMatters DELETE /services/{id}"
  );
}

async function postXMattersDependency(payload) {
  return requestJson(
    xmattersUrl("/service-dependencies"),
    {
      method: "POST",
      headers: xmattersHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(payload),
    },
    [200, 201],
    "xMatters POST /service-dependencies"
  );
}

async function deleteXMattersDependency(dependencyId) {
  return requestJson(
    xmattersUrl(`/service-dependencies/${encodeURIComponent(dependencyId)}`),
    {
      method: "DELETE",
      headers: xmattersHeaders(),
    },
    [200, 202, 204, 404],
    "xMatters DELETE /service-dependencies/{id}"
  );
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(config.stateFile, "utf8"));

    return {
      version: 2,
      byLeanixId: {},
      dependencies: {},
      ...parsed,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        version: 2,
        byLeanixId: {},
        dependencies: {},
      };
    }

    throw error;
  }
}

async function saveState(state) {
  const fullPath = path.resolve(config.stateFile);
  await fs.mkdir(path.dirname(fullPath), {
    recursive: true,
  });

  await fs.writeFile(fullPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function updateStateForService(state, desired, xmattersService) {
  state.byLeanixId[desired.leanixId] = {
    xmattersId: xmattersService.id,
    xmattersTargetName: xmattersService.targetName || desired.targetName,
    leanixType: desired.leanixType,
    lastSeenAt: new Date().toISOString(),
  };
}

async function reconcileServices(desiredServices, xmattersServices, state) {
  const summary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: 0,
  };

  const index = indexXMattersServices(xmattersServices);
  const serviceByLeanixId = new Map();
  const managedServiceIds = new Set();
  const claimedXMattersServiceIds = new Map();

  for (const desired of desiredServices) {
    const match = findExistingService(desired, index, state);

    if (match?.conflict) {
      summary.conflicts += 1;
      summary.skipped += 1;

      log(`SKIP service conflict for LeanIX ${desired.leanixId}: ${match.conflict}`);
      continue;
    }

    if (!match?.service) {
      summary.created += 1;

      if (config.dryRun) {
        log(`DRY RUN create service: ${desired.targetName}`, {
          leanixId: desired.leanixId,
          leanixType: desired.leanixType,
          serviceType: desired.body.serviceType,
          serviceTier: desired.body.serviceTier,
          owner: desired.body.ownedBy?.targetName,
        });

        const plannedService = {
          id: `DRYRUN:${desired.leanixId}`,
          ...desired.body,
        };

        serviceByLeanixId.set(desired.leanixId, plannedService);
        managedServiceIds.add(plannedService.id);

        continue;
      }

      const created = await postXMattersService(desired.body);

      updateStateForService(state, desired, created);

      index.byId.set(created.id, created);
      index.byLeanixId.set(desired.leanixId, created);
      index.byTargetName.set(normalizeKey(created.targetName), created);

      serviceByLeanixId.set(desired.leanixId, created);
      managedServiceIds.add(created.id);
      claimedXMattersServiceIds.set(created.id, desired.leanixId);

      log(`Created xMatters Service: ${created.targetName}`, {
        xmattersId: created.id,
        leanixId: desired.leanixId,
      });

      continue;
    }

    const existing = match.service;
    const alreadyClaimedByLeanixId = claimedXMattersServiceIds.get(existing.id);

    if (alreadyClaimedByLeanixId && alreadyClaimedByLeanixId !== desired.leanixId) {
      summary.conflicts += 1;
      summary.skipped += 1;

      log("SKIP service because xMatters Service is already mapped to another LeanIX Fact Sheet", {
        xmattersId: existing.id,
        xmattersTargetName: existing.targetName,
        currentLeanixId: desired.leanixId,
        alreadyClaimedByLeanixId,
        matchedBy: match.matchedBy,
      });

      continue;
    }

    claimedXMattersServiceIds.set(existing.id, desired.leanixId);

    const changes = diffService(existing, desired.body);

    if (Object.keys(changes).length === 0) {
      summary.unchanged += 1;

      updateStateForService(state, desired, existing);
      serviceByLeanixId.set(desired.leanixId, existing);
      managedServiceIds.add(existing.id);

      continue;
    }

    summary.updated += 1;

    if (config.dryRun) {
      log(`DRY RUN update service: ${existing.targetName}`, {
        xmattersId: existing.id,
        leanixId: desired.leanixId,
        matchedBy: match.matchedBy,
        changedFields: Object.keys(changes),
      });

      serviceByLeanixId.set(desired.leanixId, existing);
      managedServiceIds.add(existing.id);

      continue;
    }

    const updated = await postXMattersService({
      id: existing.id,
      ...desired.body,
    });

    updateStateForService(state, desired, updated);

    index.byId.set(updated.id, updated);
    index.byLeanixId.set(desired.leanixId, updated);
    index.byTargetName.set(normalizeKey(updated.targetName), updated);

    serviceByLeanixId.set(desired.leanixId, updated);
    managedServiceIds.add(updated.id);

    log(`Updated xMatters Service: ${updated.targetName}`, {
      xmattersId: updated.id,
      leanixId: desired.leanixId,
      changedFields: Object.keys(changes),
    });
  }

  return {
    summary,
    serviceByLeanixId,
    managedServiceIds,
  };
}

function relationTypeCandidates(relation) {
  return [
    relation.type,
    relation.typeFromFS,
    relation.typeToFS,
    relation.relationType,
    relation.name,
  ]
    .filter(Boolean)
    .map(String);
}

function normalizeLeanixRelation(relation, sourceFactSheetId) {
  const fromId =
    relation.fromId ||
    relation.factSheetIdFrom ||
    relation.fromFactSheetId ||
    relation.sourceFactSheetId ||
    relation.from?.id ||
    relation.fromFactSheet?.id ||
    relation.factSheetFrom?.id ||
    relation.source?.id ||
    relation.source?.factSheet?.id;

  const toId =
    relation.toId ||
    relation.factSheetIdTo ||
    relation.toFactSheetId ||
    relation.targetFactSheetId ||
    relation.to?.id ||
    relation.toFactSheet?.id ||
    relation.factSheetTo?.id ||
    relation.target?.id ||
    relation.target?.factSheet?.id ||
    relation.factSheet?.id;

  return {
    id:
      relation.id ||
      relation.relationId ||
      `${sourceFactSheetId}:${fromId || "unknown"}:${toId || "unknown"}:${relation.type || "unknown"}`,
    fromId,
    toId,
    status: relation.status,
    raw: relation,
    typeCandidates: relationTypeCandidates(relation),
  };
}

function ruleForRelation(normalizedRelation) {
  return config.dependencyRules.find((rule) =>
    normalizedRelation.typeCandidates.some(
      (candidate) => candidate.toLowerCase() === String(rule.type).toLowerCase()
    )
  );
}

function relationEndpointId(normalizedRelation, side) {
  return side === "from" ? normalizedRelation.fromId : normalizedRelation.toId;
}

function summarizeRelationTypes(leanixRelations) {
  const counts = new Map();

  for (const item of leanixRelations) {
    const relation = normalizeLeanixRelation(item.relation, item.sourceFactSheetId);

    const key = relation.typeCandidates.length
      ? relation.typeCandidates.join(" | ")
      : "UNKNOWN_RELATION_TYPE";

    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.relationTypeSummaryLimit)
    .map(([type, count]) => ({
      type,
      count,
    }));
}

function buildDesiredDependencies(leanixRelations, desiredByLeanixId, serviceByLeanixId) {
  const desired = new Map();

  const skipped = {
    unsupportedType: 0,
    missingEndpoint: 0,
    outOfScopeEndpoint: 0,
    inactive: 0,
    selfDependency: 0,
  };

  for (const item of leanixRelations) {
    const relation = normalizeLeanixRelation(item.relation, item.sourceFactSheetId);

    if (relation.status && String(relation.status).toUpperCase() !== "ACTIVE") {
      skipped.inactive += 1;
      continue;
    }

    const rule = ruleForRelation(relation);

    if (!rule) {
      skipped.unsupportedType += 1;
      continue;
    }

    const dependedOnLeanixId = relationEndpointId(relation, rule.dependedOn);
    const dependentLeanixId = relationEndpointId(relation, rule.dependent);

    if (!dependedOnLeanixId || !dependentLeanixId) {
      skipped.missingEndpoint += 1;
      continue;
    }

    if (dependedOnLeanixId === dependentLeanixId) {
      skipped.selfDependency += 1;
      continue;
    }

    if (!desiredByLeanixId.has(dependedOnLeanixId) || !desiredByLeanixId.has(dependentLeanixId)) {
      skipped.outOfScopeEndpoint += 1;
      continue;
    }

    const service = serviceByLeanixId.get(dependedOnLeanixId);
    const dependentService = serviceByLeanixId.get(dependentLeanixId);

    if (!service?.id || !dependentService?.id) {
      skipped.outOfScopeEndpoint += 1;
      continue;
    }

    if (service.id === dependentService.id) {
      skipped.selfDependency += 1;

      log("SKIP dependency because both endpoints resolved to the same xMatters Service", {
        leanixRelationId: relation.id,
        leanixRelationType: rule.type,
        dependedOnLeanixId,
        dependentLeanixId,
        xmattersServiceId: service.id,
        xmattersServiceName: service.targetName,
      });

      continue;
    }

    const key = `${service.id}|${dependentService.id}`;

    if (!desired.has(key)) {
      desired.set(key, {
        key,
        serviceId: service.id,
        dependentServiceId: dependentService.id,
        dependedOnLeanixId,
        dependentLeanixId,
        leanixRelationId: relation.id,
        leanixRelationType: rule.type,
      });
    }
  }

  return {
    desiredDependencies: [...desired.values()],
    skipped,
  };
}

function dependencyEndpointId(ref) {
  if (!ref) return "";
  if (typeof ref === "string") return ref;

  return ref.id || "";
}

function dependencyKey(dependency) {
  const serviceId = dependency.serviceId || dependencyEndpointId(dependency.service);
  const dependentServiceId =
    dependency.dependentServiceId || dependencyEndpointId(dependency.dependentService);

  return serviceId && dependentServiceId ? `${serviceId}|${dependentServiceId}` : null;
}

function indexDependencies(dependencies) {
  const byKey = new Map();

  for (const dependency of dependencies) {
    const key = dependencyKey(dependency);

    if (key && !byKey.has(key)) {
      byKey.set(key, dependency);
    }
  }

  return byKey;
}

function dependencyTouchesManagedServices(dependency, managedServiceIds) {
  const key = dependencyKey(dependency);

  if (!key) return false;

  const [serviceId, dependentServiceId] = key.split("|");

  return managedServiceIds.has(serviceId) && managedServiceIds.has(dependentServiceId);
}

function dependencyTouchesAnyService(dependency, serviceIds) {
  const key = dependencyKey(dependency);

  if (!key) return false;

  const [serviceId, dependentServiceId] = key.split("|");

  return serviceIds.has(serviceId) || serviceIds.has(dependentServiceId);
}

async function reconcileDependencies(desiredDependencies, xmattersDependencies, managedServiceIds, state) {
  const summary = {
    created: 0,
    unchanged: 0,
    deleted: 0,
    skipped: 0,
  };

  const desiredByKey = new Map(desiredDependencies.map((dep) => [dep.key, dep]));
  const existingByKey = indexDependencies(xmattersDependencies);

  for (const desired of desiredDependencies) {
    if (desired.serviceId === desired.dependentServiceId) {
      summary.skipped += 1;

      log("SKIP service dependency because serviceId and dependentServiceId are identical", {
        serviceId: desired.serviceId,
        dependentServiceId: desired.dependentServiceId,
        leanixRelationId: desired.leanixRelationId,
        leanixRelationType: desired.leanixRelationType,
        dependedOnLeanixId: desired.dependedOnLeanixId,
        dependentLeanixId: desired.dependentLeanixId,
      });

      continue;
    }

    const existing = existingByKey.get(desired.key);

    if (existing) {
      summary.unchanged += 1;

      if (existing.id) {
        state.dependencies[desired.key] = {
          xmattersId: existing.id,
          serviceId: desired.serviceId,
          dependentServiceId: desired.dependentServiceId,
          leanixRelationId: desired.leanixRelationId,
          leanixRelationType: desired.leanixRelationType,
          lastSeenAt: new Date().toISOString(),
        };
      }

      continue;
    }

    summary.created += 1;

    if (config.dryRun) {
      log("DRY RUN create service dependency", desired);
      continue;
    }

    const created = await postXMattersDependency({
      serviceId: desired.serviceId,
      dependentServiceId: desired.dependentServiceId,
    });

    const createdKey = dependencyKey(created) || desired.key;

    state.dependencies[createdKey] = {
      xmattersId: created.id,
      serviceId: desired.serviceId,
      dependentServiceId: desired.dependentServiceId,
      leanixRelationId: desired.leanixRelationId,
      leanixRelationType: desired.leanixRelationType,
      lastSeenAt: new Date().toISOString(),
    };

    log("Created xMatters Service Dependency", {
      xmattersId: created.id,
      key: desired.key,
      leanixRelationType: desired.leanixRelationType,
    });
  }

  if (!config.deleteStaleDependencies) {
    return summary;
  }

  const staleDependencies = xmattersDependencies.filter((dependency) => {
    const key = dependencyKey(dependency);

    return (
      key &&
      dependency.id &&
      dependencyTouchesManagedServices(dependency, managedServiceIds) &&
      !desiredByKey.has(key)
    );
  });

  if (staleDependencies.length > config.maxDependencyDeletes) {
    throw new Error(
      `Refusing to delete ${staleDependencies.length} dependencies because maxDependencyDeletes=${config.maxDependencyDeletes}.`
    );
  }

  for (const dependency of staleDependencies) {
    const key = dependencyKey(dependency);

    summary.deleted += 1;

    if (config.dryRun) {
      log("DRY RUN delete stale service dependency", {
        xmattersId: dependency.id,
        key,
      });

      continue;
    }

    await deleteXMattersDependency(dependency.id);
    delete state.dependencies[key];

    log("Deleted stale xMatters Service Dependency", {
      xmattersId: dependency.id,
      key,
    });
  }

  return summary;
}

function managedLeanixIdForService(service, state) {
  const markerId = extractLeanixFactSheetIdFromDescription(service.description);

  if (markerId) {
    return markerId;
  }

  for (const [leanixId, entry] of Object.entries(state.byLeanixId || {})) {
    if (entry?.xmattersId === service.id) {
      return leanixId;
    }
  }

  return null;
}

async function deleteDependenciesTouchingServices(serviceIds, xmattersDependencies, alreadyDeletedDependencyIds) {
  const touching = xmattersDependencies.filter(
    (dep) =>
      dep.id &&
      !alreadyDeletedDependencyIds.has(dep.id) &&
      dependencyTouchesAnyService(dep, serviceIds)
  );

  for (const dependency of touching) {
    const key = dependencyKey(dependency);

    if (config.dryRun) {
      log("DRY RUN delete dependency before stale service delete", {
        xmattersId: dependency.id,
        key,
      });
    } else {
      await deleteXMattersDependency(dependency.id);

      log("Deleted dependency before stale service delete", {
        xmattersId: dependency.id,
        key,
      });
    }

    alreadyDeletedDependencyIds.add(dependency.id);
  }

  return touching.length;
}

async function deleteStaleServices(desiredByLeanixId, xmattersServices, xmattersDependencies, state) {
  const summary = {
    deleted: 0,
    skipped: 0,
    dependencyDeletes: 0,
  };

  if (!config.deleteStaleServices) {
    return summary;
  }

  if (desiredByLeanixId.size === 0 && !config.allowDeleteWhenNoLeanixResults) {
    throw new Error(
      "LeanIX returned zero desired services. Refusing stale service deletion unless allowDeleteWhenNoLeanixResults=true."
    );
  }

  const stale = [];

  for (const service of xmattersServices) {
    if (!service.id) continue;

    const leanixId = managedLeanixIdForService(service, state);

    if (leanixId && !desiredByLeanixId.has(leanixId)) {
      stale.push({
        service,
        leanixId,
      });
    }
  }

  if (stale.length > config.maxServiceDeletes) {
    throw new Error(
      `Refusing to delete ${stale.length} services because maxServiceDeletes=${config.maxServiceDeletes}.`
    );
  }

  const staleServiceIds = new Set(stale.map((item) => item.service.id));
  const alreadyDeletedDependencyIds = new Set();

  summary.dependencyDeletes = await deleteDependenciesTouchingServices(
    staleServiceIds,
    xmattersDependencies,
    alreadyDeletedDependencyIds
  );

  for (const { service, leanixId } of stale) {
    summary.deleted += 1;

    if (config.dryRun) {
      log("DRY RUN delete stale service", {
        xmattersId: service.id,
        targetName: service.targetName,
        leanixId,
      });

      continue;
    }

    await deleteXMattersService(service.id);
    delete state.byLeanixId[leanixId];

    log("Deleted stale xMatters Service", {
      xmattersId: service.id,
      targetName: service.targetName,
      leanixId,
    });
  }

  return summary;
}

async function main() {
  log("Starting SAP LeanIX to xMatters sync", {
    dryRun: config.dryRun,
    leanixBaseUrl: config.leanixBaseUrl,
    xmattersBaseUrl: config.xmattersBaseUrl,
    factSheetTypes: config.leanixFactSheetTypes,
    dependencyRules: config.dependencyRules,
    deleteStaleServices: config.deleteStaleServices,
    deleteStaleDependencies: config.deleteStaleDependencies,
    maxServiceDeletes: config.maxServiceDeletes,
    maxDependencyDeletes: config.maxDependencyDeletes,
  });

  const state = await loadState();

  await getLeanixAccessToken();

  const leanixFactSheets = await fetchAllLeanixFactSheets();
  const ownerResolutionByLeanixId = await resolveItilAssignmentOwnerGroups(leanixFactSheets);
  const serviceTargetNameResolutionByLeanixId =
    await resolveServiceTargetNamesAgainstXMattersGroups(leanixFactSheets);
  const desiredServices = leanixFactSheets.map((fs) =>
    buildDesiredService(fs, ownerResolutionByLeanixId, serviceTargetNameResolutionByLeanixId)
  );

  const desiredNameCollisions = summarizeDesiredServiceNameCollisions(desiredServices);

  if (desiredNameCollisions.length > 0) {
    log("WARNING: Multiple LeanIX Fact Sheets produce the same xMatters targetName", {
      count: desiredNameCollisions.length,
      collisions: desiredNameCollisions.slice(0, 25),
    });
  }

  const desiredByLeanixId = new Map(desiredServices.map((svc) => [svc.leanixId, svc]));

  const [xmattersServices, xmattersDependencies] = await Promise.all([
    fetchAllXMattersServices(),
    fetchAllXMattersDependencies(),
  ]);

  const serviceResult = await reconcileServices(desiredServices, xmattersServices, state);

  const mappingCollisions = summarizeXMattersServiceMappingCollisions(serviceResult.serviceByLeanixId);

  if (mappingCollisions.length > 0) {
    log("WARNING: Multiple LeanIX Fact Sheets resolved to the same xMatters Service", {
      count: mappingCollisions.length,
      collisions: mappingCollisions.slice(0, 25),
    });
  }

  const leanixRelations = await fetchLeanixRelationsForDesiredServices(desiredServices);

  if (config.logRelationTypeSummary) {
    log("Top LeanIX relation type candidates", summarizeRelationTypes(leanixRelations));
  }

  const dependencyBuild = buildDesiredDependencies(
    leanixRelations,
    desiredByLeanixId,
    serviceResult.serviceByLeanixId
  );

  log("Built desired dependency set", {
    desiredDependencies: dependencyBuild.desiredDependencies.length,
    skippedRelations: dependencyBuild.skipped,
  });

  const dependencySummary = await reconcileDependencies(
    dependencyBuild.desiredDependencies,
    xmattersDependencies,
    serviceResult.managedServiceIds,
    state
  );

  const staleServiceSummary = await deleteStaleServices(
    desiredByLeanixId,
    xmattersServices,
    xmattersDependencies,
    state
  );

  if (!config.dryRun) {
    state.lastRunAt = new Date().toISOString();
    await saveState(state);
    log(`Saved state file: ${config.stateFile}`);
  } else {
    log("Dry run enabled; no xMatters changes were made and state file was not saved.");
  }

  log("Sync complete", {
    desiredServices: desiredServices.length,
    xmattersServices: xmattersServices.length,
    xmattersDependencies: xmattersDependencies.length,
    services: serviceResult.summary,
    dependencies: dependencySummary,
    staleServices: staleServiceSummary,
  });

  if (serviceResult.summary.conflicts > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
