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
const FR24_LIVE_CACHE_MAX_AGE = 10 * 60 * 1000;
const FR24_SUMMARY_CACHE_MAX_AGE = 15 * 60 * 1000;

const apiCache = {
  tdx: null,
  tdxFlights: new Map(),
  tdxAccessToken: null,
  fr24Live: null,
  fr24Flights: new Map(),
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

function normalizeRequestedFlight(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^SJX0*/, "JX")
    .replace(/^JX0+/, "JX");
}

function parseFlightList(value) {
  return [...new Set(String(value || "")
    .split(",")
    .map(normalizeRequestedFlight)
    .filter((flight) => /^JX\d+$/.test(flight)))]
    .slice(0, 15);
}

function getFlightNumber(flight) {
  return normalizeRequestedFlight(flight).replace(/^JX/, "");
}

function getFlightCacheKey(flights) {
  return [...flights].sort().join(",");
}

function getNormalizedFr24FlightCode(flight) {
  return normalizeRequestedFlight(flight.flight || flight.callsign || "");
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
    flight: normalizeRequestedFlight(flight.flight || flight.callsign || ""),
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

function normalizeFr24SummaryLiveFlight(flight) {
  return {
    flight: normalizeRequestedFlight(flight.flight || flight.callsign || ""),
    callsign: flight.callsign || "",
    fr24Id: flight.fr24_id || flight.flight_id || flight.id || "",
    origin: flight.orig_iata || flight.orig_icao || "",
    destination: flight.dest_iata || flight.dest_icao || "",
    aircraft: flight.type || flight.aircraft || "",
    registration: flight.reg || flight.registration || "",
    altitude: null,
    groundSpeed: null,
    heading: null,
    eta: flight.eta || flight.datetime_landed || "",
    latitude: null,
    longitude: null,
    updatedAt: flight.last_seen || flight.first_seen || new Date().toISOString(),
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

async function fetchFr24LiveStarlux(force = false) {
  if (!force && isFreshCache(apiCache.fr24Live, FR24_LIVE_CACHE_MAX_AGE)) {
    return { ...apiCache.fr24Live.payload, cached: true };
  }

  if (!FR24_API_TOKEN) {
    return apiCache.fr24Live?.payload || { available: false, reason: "FR24_API_TOKEN is not set", flights: [] };
  }

  const url = new URL("https://fr24api.flightradar24.com/api/live/flight-positions/full");
  url.searchParams.set("operating_as", "SJX");
  url.searchParams.set("airports", "outbound:RCTP,inbound:RCTP");
  url.searchParams.set("limit", "10");

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
    ? rawPayload.data.map(normalizeFr24Flight).filter((flight) => getNormalizedFr24FlightCode(flight).startsWith("JX"))
    : [];

  const payload = {
    available: true,
    flights,
    sourceUpdatedAt: new Date().toISOString(),
  };

  apiCache.fr24Live = { savedAt: Date.now(), payload };
  return payload;
}

async function fetchFr24FlightsByNumber(flights, force = false) {
  const flightList = parseFlightList(flights);
  const cacheKey = getFlightCacheKey(flightList);
  const cached = apiCache.fr24Flights.get(cacheKey);

  if (flightList.length === 0) {
    return { available: true, flights: [], sourceUpdatedAt: new Date().toISOString() };
  }

  if (!force && isFreshCache(cached, FR24_LIVE_CACHE_MAX_AGE)) {
    return { ...cached.payload, cached: true };
  }

  if (!FR24_API_TOKEN) {
    return cached?.payload || { available: false, reason: "FR24_API_TOKEN is not set", flights: [] };
  }

  const callsigns = flightList.map((flight) => flight.replace(/^JX/, "SJX"));
  let liveFlights = [];
  const liveUrl = new URL("https://fr24api.flightradar24.com/api/live/flight-positions/full");
  liveUrl.searchParams.set("flights", flightList.join(","));
  liveUrl.searchParams.set("callsigns", callsigns.join(","));
  liveUrl.searchParams.set("airports", "outbound:RCTP,inbound:RCTP");
  liveUrl.searchParams.set("limit", String(flightList.length));

  const liveResponse = await fetch(liveUrl, { headers: getFr24Headers() });

  if (liveResponse.ok) {
    const rawPayload = await liveResponse.json();
    liveFlights = Array.isArray(rawPayload.data)
      ? rawPayload.data
        .map(normalizeFr24Flight)
        .filter((flight) => flightList.includes(getNormalizedFr24FlightCode(flight)))
      : [];

    const liveFlightCodes = new Set(liveFlights.map(getNormalizedFr24FlightCode));
    const hasEveryRequestedFlight = flightList.every((flight) => liveFlightCodes.has(flight));
    const hasEtaForEveryLiveFlight = liveFlights.every((flight) => flight.eta);

    if (liveFlights.length > 0 && hasEveryRequestedFlight && hasEtaForEveryLiveFlight) {
      const payload = {
        available: true,
        flights: liveFlights,
        sourceUpdatedAt: new Date().toISOString(),
      };
      apiCache.fr24Flights.set(cacheKey, { savedAt: Date.now(), payload });
      return payload;
    }
  }

  const now = new Date();
  const from = new Date(now.getTime() - 18 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 36 * 60 * 60 * 1000);
  const summaryUrl = new URL("https://fr24api.flightradar24.com/api/flight-summary/light");
  summaryUrl.searchParams.set("flight_datetime_from", from.toISOString().slice(0, 19));
  summaryUrl.searchParams.set("flight_datetime_to", to.toISOString().slice(0, 19));
  summaryUrl.searchParams.set("flights", flightList.join(","));
  summaryUrl.searchParams.set("operating_as", "SJX");
  summaryUrl.searchParams.set("airports", "outbound:RCTP,inbound:RCTP");
  summaryUrl.searchParams.set("limit", String(Math.max(10, flightList.length * 4)));
  summaryUrl.searchParams.set("sort", "desc");

  const summaryResponse = await fetch(summaryUrl, { headers: getFr24Headers() });

  if (!summaryResponse.ok) {
    return {
      available: false,
      reason: `FR24 API returned HTTP ${summaryResponse.status}`,
      flights: cached?.payload?.flights || [],
    };
  }

  const rawSummaryPayload = await summaryResponse.json();
  const sourceFlights = Array.isArray(rawSummaryPayload.data)
    ? rawSummaryPayload.data
    : Array.isArray(rawSummaryPayload.flights)
      ? rawSummaryPayload.flights
      : Array.isArray(rawSummaryPayload)
        ? rawSummaryPayload
        : [];
  const liveFlightMap = new Map(liveFlights.map((flight) => [getNormalizedFr24FlightCode(flight), flight]));
  const seenFlights = new Set();
  const summaryFlightMap = new Map(sourceFlights
    .map(normalizeFr24SummaryLiveFlight)
    .filter((flight) => {
      if (!flightList.includes(flight.flight) || seenFlights.has(flight.flight)) {
        return false;
      }

      seenFlights.add(flight.flight);
      return true;
    })
    .map((flight) => [flight.flight, flight]));
  const mergedFlights = flightList
    .map((flight) => {
      const liveFlight = liveFlightMap.get(flight);
      const summaryFlight = summaryFlightMap.get(flight);

      if (liveFlight && summaryFlight) {
        return {
          ...summaryFlight,
          ...liveFlight,
          eta: liveFlight.eta || summaryFlight.eta,
          aircraft: liveFlight.aircraft || summaryFlight.aircraft,
          registration: liveFlight.registration || summaryFlight.registration,
          fr24Id: liveFlight.fr24Id || summaryFlight.fr24Id,
        };
      }

      return liveFlight || summaryFlight || null;
    })
    .filter(Boolean);
  const payload = {
    available: true,
    flights: mergedFlights,
    sourceUpdatedAt: new Date().toISOString(),
  };

  apiCache.fr24Flights.set(cacheKey, { savedAt: Date.now(), payload });
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

async function handleFr24Request(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    sendJson(response, 200, await fetchFr24LiveStarlux(url.searchParams.get("force") === "1"));
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

async function handleFr24FlightsRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    sendJson(response, 200, await fetchFr24FlightsByNumber(
      url.searchParams.get("flights") || "",
      url.searchParams.get("force") === "1",
    ));
  } catch (error) {
    sendJson(response, 502, {
      available: false,
      reason: error instanceof Error ? error.message : "Unknown FR24 tracked flights proxy error",
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

async function handleTdxRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const force = url.searchParams.get("force") === "1";

    if (!force && isFreshCache(apiCache.tdx, TDX_CACHE_MAX_AGE)) {
      response.writeHead(apiCache.tdx.status, {
        "content-type": apiCache.tdx.contentType,
        "cache-control": "no-store",
        "x-starlux-cache": "hit",
        "x-starlux-updated-at": new Date(apiCache.tdx.savedAt).toISOString(),
      });
      response.end(apiCache.tdx.body);
      return;
    }

    const headers = { accept: "application/json" };

    const tdxAccessToken = await getTdxAccessToken();

    if (tdxAccessToken) {
      headers.authorization = `Bearer ${tdxAccessToken}`;
    }

    const tdxUrl = new URL("https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Flight");
    tdxUrl.searchParams.set("IsCargo", "false");
    tdxUrl.searchParams.set("$filter", "AirlineID eq 'JX'");
    tdxUrl.searchParams.set("$top", "100");
    tdxUrl.searchParams.set("$format", "JSON");

    const tdxResponse = await fetch(tdxUrl, { headers });
    const text = await tdxResponse.text();
    const contentType = tdxResponse.headers.get("content-type") || "application/json; charset=utf-8";
    const updatedAt = Date.now();

    if (tdxResponse.ok) {
      apiCache.tdx = {
        savedAt: updatedAt,
        status: tdxResponse.status,
        contentType,
        body: text,
      };
    }

    response.writeHead(tdxResponse.status, {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-starlux-cache": "miss",
      "x-starlux-updated-at": new Date(updatedAt).toISOString(),
    });
    response.end(text);
  } catch (error) {
    if (apiCache.tdx) {
      response.writeHead(apiCache.tdx.status, {
        "content-type": apiCache.tdx.contentType,
        "cache-control": "no-store",
        "x-starlux-cache": "stale",
        "x-starlux-updated-at": new Date(apiCache.tdx.savedAt).toISOString(),
      });
      response.end(apiCache.tdx.body);
      return;
    }

    sendJson(response, 502, {
      error: error instanceof Error ? error.message : "Unknown TDX proxy error",
    });
  }
}

async function handleTdxFlightsRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const flightList = parseFlightList(url.searchParams.get("flights") || "");
    const force = url.searchParams.get("force") === "1";
    const cacheKey = getFlightCacheKey(flightList);
    const cached = apiCache.tdxFlights.get(cacheKey);

    if (flightList.length === 0) {
      sendJson(response, 200, []);
      return;
    }

    if (!force && isFreshCache(cached, TDX_CACHE_MAX_AGE)) {
      response.writeHead(cached.status, {
        "content-type": cached.contentType,
        "cache-control": "no-store",
        "x-starlux-cache": "hit",
        "x-starlux-updated-at": new Date(cached.savedAt).toISOString(),
      });
      response.end(cached.body);
      return;
    }

    const headers = { accept: "application/json" };
    const tdxAccessToken = await getTdxAccessToken();

    if (tdxAccessToken) {
      headers.authorization = `Bearer ${tdxAccessToken}`;
    }

    const flightFilters = flightList
      .map((flight) => `FlightNumber eq '${getFlightNumber(flight)}'`)
      .join(" or ");
    const tdxUrl = new URL("https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Flight");
    tdxUrl.searchParams.set("IsCargo", "false");
    tdxUrl.searchParams.set("$filter", `AirlineID eq 'JX' and (${flightFilters})`);
    tdxUrl.searchParams.set("$top", "100");
    tdxUrl.searchParams.set("$format", "JSON");

    const tdxResponse = await fetch(tdxUrl, { headers });
    const text = await tdxResponse.text();
    const contentType = tdxResponse.headers.get("content-type") || "application/json; charset=utf-8";
    const updatedAt = Date.now();

    if (tdxResponse.ok) {
      apiCache.tdxFlights.set(cacheKey, {
        savedAt: updatedAt,
        status: tdxResponse.status,
        contentType,
        body: text,
      });
    }

    response.writeHead(tdxResponse.status, {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-starlux-cache": "miss",
      "x-starlux-updated-at": new Date(updatedAt).toISOString(),
    });
    response.end(text);
  } catch (error) {
    sendJson(response, 502, {
      error: error instanceof Error ? error.message : "Unknown TDX tracked flights proxy error",
    });
  }
}

async function handleStaticRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/"
    ? "/index.html"
    : url.pathname.endsWith("/")
      ? `${url.pathname}index.html`
      : url.pathname;
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
    handleFr24Request(request, response);
    return;
  }

  if (url.pathname === "/api/fr24/flights") {
    handleFr24FlightsRequest(request, response);
    return;
  }

  if (url.pathname === "/api/fr24/flight-summary") {
    handleFr24SummaryRequest(request, response);
    return;
  }

  if (url.pathname === "/api/tdx/fids/tpe") {
    handleTdxRequest(request, response);
    return;
  }

  if (url.pathname === "/api/tdx/fids/flights") {
    handleTdxFlightsRequest(request, response);
    return;
  }

  handleStaticRequest(request, response);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`StarLux board server running at http://127.0.0.1:${PORT}/`);
});
