const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 4173);
const FR24_API_TOKEN = process.env.FR24_API_TOKEN;
const TDX_API_TOKEN = process.env.TDX_API_TOKEN || process.env.TDX_API_KEY;
const TDX_CLIENT_ID = process.env.TDX_CLIENT_ID;
const TDX_CLIENT_SECRET = process.env.TDX_CLIENT_SECRET;
const ROOT = __dirname;
const TDX_CACHE_MAX_AGE = 15 * 60 * 1000;
const FR24_LIVE_CACHE_MAX_AGE = 2 * 60 * 1000;
const FR24_SUMMARY_CACHE_MAX_AGE = 15 * 60 * 1000;

const apiCache = {
  tdx: null,
  tdxAccessToken: null,
  fr24Live: null,
  fr24Summary: new Map(),
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function isFreshCache(entry, maxAge) {
  return Boolean(entry && Date.now() - entry.savedAt < maxAge);
}

function getFr24Headers() {
  return {
    accept: "application/json",
    "accept-version": "v1",
    authorization: `Bearer ${FR24_API_TOKEN}`,
  };
}

async function getTdxAccessToken() {
  if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
    return TDX_API_TOKEN || "";
  }

  if (apiCache.tdxAccessToken && Date.now() < apiCache.tdxAccessToken.expiresAt) {
    return apiCache.tdxAccessToken.token;
  }

  const response = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: TDX_CLIENT_ID,
      client_secret: TDX_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    throw new Error(`TDX auth returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const token = payload.access_token || "";

  if (!token) {
    throw new Error("TDX auth response did not include an access token");
  }

  apiCache.tdxAccessToken = {
    token,
    expiresAt: Date.now() + Math.max(0, Number(payload.expires_in || 3600) - 60) * 1000,
  };

  return token;
}

function normalizeFr24Flight(flight) {
  return {
    flight: flight.flight || "",
    callsign: flight.callsign || "",
    fr24Id: flight.fr24_id || "",
    origin: flight.orig_iata || flight.orig_icao || "",
    destination: flight.dest_iata || flight.dest_icao || "",
    aircraft: flight.type || "",
    registration: flight.reg || "",
    altitude: flight.alt ?? null,
    groundSpeed: flight.gspeed ?? null,
    heading: flight.track ?? null,
    eta: flight.eta || "",
    latitude: flight.lat ?? null,
    longitude: flight.lon ?? null,
    updatedAt: flight.timestamp || new Date().toISOString(),
  };
}

function normalizeFr24SummaryFlight(flight) {
  return {
    fr24Id: flight.fr24_id || flight.flight_id || flight.id || "",
    flight: flight.flight || flight.callsign || "",
    aircraft: flight.type || flight.aircraft || "",
    registration: flight.reg || flight.registration || "",
  };
}

async function fetchFr24LiveStarlux() {
  if (isFreshCache(apiCache.fr24Live, FR24_LIVE_CACHE_MAX_AGE)) {
    return { ...apiCache.fr24Live.payload, cached: true };
  }

  if (!FR24_API_TOKEN) {
    return apiCache.fr24Live?.payload || { available: false, reason: "FR24_API_TOKEN is not set", flights: [] };
  }

  const url = new URL("https://fr24api.flightradar24.com/api/live/flight-positions/full");
  url.searchParams.set("operating_as", "SJX");
  url.searchParams.set("airports", "outbound:RCTP,inbound:RCTP");
  url.searchParams.set("limit", "100");

  const response = await fetch(url, { headers: getFr24Headers() });

  if (!response.ok) {
    return {
      available: false,
      reason: `FR24 API returned HTTP ${response.status}`,
      flights: [],
    };
  }

  const rawPayload = await response.json();
  const flights = Array.isArray(rawPayload.data)
    ? rawPayload.data.map(normalizeFr24Flight).filter((flight) => flight.flight.startsWith("JX"))
    : [];

  const payload = {
    available: true,
    flights,
    sourceUpdatedAt: new Date().toISOString(),
  };

  apiCache.fr24Live = { savedAt: Date.now(), payload };
  return payload;
}

async function fetchFr24FlightSummary(ids) {
  if (!FR24_API_TOKEN) {
    return { available: false, reason: "FR24_API_TOKEN is not set", flights: [] };
  }

  const flightIds = [...new Set(ids
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean))]
    .slice(0, 10);

  if (flightIds.length === 0) {
    return { available: true, flights: [] };
  }

  const cachedFlights = [];
  const missingFlightIds = [];

  for (const id of flightIds) {
    const cached = apiCache.fr24Summary.get(id);

    if (isFreshCache(cached, FR24_SUMMARY_CACHE_MAX_AGE)) {
      cachedFlights.push(cached.flight);
    } else {
      missingFlightIds.push(id);
    }
  }

  if (missingFlightIds.length === 0) {
    return {
      available: true,
      cached: true,
      flights: cachedFlights,
      sourceUpdatedAt: new Date().toISOString(),
    };
  }

  const url = new URL("https://fr24api.flightradar24.com/api/flight-summary/light");
  url.searchParams.set("flight_ids", missingFlightIds.join(","));

  const response = await fetch(url, { headers: getFr24Headers() });

  if (!response.ok) {
    return {
      available: false,
      reason: `FR24 summary API returned HTTP ${response.status}`,
      flights: cachedFlights,
    };
  }

  const payload = await response.json();
  const sourceFlights = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.flights)
      ? payload.flights
      : Array.isArray(payload)
        ? payload
        : [];
  const flights = sourceFlights
    .map(normalizeFr24SummaryFlight)
    .filter((flight) => flight.fr24Id);

  for (const flight of flights) {
    apiCache.fr24Summary.set(flight.fr24Id, { savedAt: Date.now(), flight });
  }

  return {
    available: true,
    flights: [...cachedFlights, ...flights],
    sourceUpdatedAt: new Date().toISOString(),
  };
}

async function handleFr24Request(response) {
  try {
    sendJson(response, 200, await fetchFr24LiveStarlux());
  } catch (error) {
    if (apiCache.fr24Live) {
      sendJson(response, 200, {
        ...apiCache.fr24Live.payload,
        cached: "stale",
        reason: error instanceof Error ? error.message : "Unknown FR24 proxy error",
      });
      return;
    }

    sendJson(response, 502, {
      available: false,
      reason: error instanceof Error ? error.message : "Unknown FR24 proxy error",
      flights: [],
    });
  }
}

async function handleFr24SummaryRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    sendJson(response, 200, await fetchFr24FlightSummary(url.searchParams.get("ids") || ""));
  } catch (error) {
    sendJson(response, 502, {
      available: false,
      reason: error instanceof Error ? error.message : "Unknown FR24 summary proxy error",
      flights: [],
    });
  }
}

async function handleTdxRequest(response) {
  try {
    if (isFreshCache(apiCache.tdx, TDX_CACHE_MAX_AGE)) {
      response.writeHead(apiCache.tdx.status, {
        "content-type": apiCache.tdx.contentType,
        "cache-control": "no-store",
        "x-starlux-cache": "hit",
      });
      response.end(apiCache.tdx.body);
      return;
    }

    const headers = { accept: "application/json" };

    const tdxAccessToken = await getTdxAccessToken();

    if (tdxAccessToken) {
      headers.authorization = `Bearer ${tdxAccessToken}`;
    }

    const url = new URL("https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Flight");
    url.searchParams.set("IsCargo", "false");
    url.searchParams.set("$filter", "AirlineID eq 'JX'");
    url.searchParams.set("$top", "100");
    url.searchParams.set("$format", "JSON");

    const tdxResponse = await fetch(url, { headers });
    const text = await tdxResponse.text();
    const contentType = tdxResponse.headers.get("content-type") || "application/json; charset=utf-8";

    if (tdxResponse.ok) {
      apiCache.tdx = {
        savedAt: Date.now(),
        status: tdxResponse.status,
        contentType,
        body: text,
      };
    }

    response.writeHead(tdxResponse.status, {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-starlux-cache": "miss",
    });
    response.end(text);
  } catch (error) {
    if (apiCache.tdx) {
      response.writeHead(apiCache.tdx.status, {
        "content-type": apiCache.tdx.contentType,
        "cache-control": "no-store",
        "x-starlux-cache": "stale",
      });
      response.end(apiCache.tdx.body);
      return;
    }

    sendJson(response, 502, {
      error: error instanceof Error ? error.message : "Unknown TDX proxy error",
    });
  }
}

async function handleStaticRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, requestedPath));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/api/fr24/starlux-live") {
    handleFr24Request(response);
    return;
  }

  if (url.pathname === "/api/fr24/flight-summary") {
    handleFr24SummaryRequest(request, response);
    return;
  }

  if (url.pathname === "/api/tdx/fids/tpe") {
    handleTdxRequest(response);
    return;
  }

  handleStaticRequest(request, response);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`StarLux board server running at http://127.0.0.1:${PORT}/`);
});
