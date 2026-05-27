const TDX_CACHE_MAX_AGE = 15 * 60 * 1000;
const FR24_LIVE_CACHE_MAX_AGE = 10 * 60 * 1000;

const apiCache = globalThis.__starluxCloudflareCache || {
  tdxFlights: new Map(),
  tdxAccessToken: null,
  fr24Flights: new Map(),
};

globalThis.__starluxCloudflareCache = apiCache;

function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
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

function getFr24Headers(env) {
  return {
    accept: "application/json",
    "accept-version": "v1",
    authorization: `Bearer ${env.FR24_API_TOKEN || ""}`,
  };
}

async function getTdxAccessToken(env) {
  if (!env.TDX_CLIENT_ID || !env.TDX_CLIENT_SECRET) {
    return env.TDX_API_TOKEN || env.TDX_API_KEY || "";
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
      client_id: env.TDX_CLIENT_ID,
      client_secret: env.TDX_CLIENT_SECRET,
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

async function fetchFr24FlightsByNumber(flights, env, force = false) {
  const flightList = parseFlightList(flights);
  const cacheKey = getFlightCacheKey(flightList);
  const cached = apiCache.fr24Flights.get(cacheKey);

  if (flightList.length === 0) {
    return { available: true, flights: [], sourceUpdatedAt: new Date().toISOString() };
  }

  if (!force && isFreshCache(cached, FR24_LIVE_CACHE_MAX_AGE)) {
    return { ...cached.payload, cached: true };
  }

  if (!env.FR24_API_TOKEN) {
    return cached?.payload || { available: false, reason: "FR24_API_TOKEN is not set", flights: [] };
  }

  const callsigns = flightList.map((flight) => flight.replace(/^JX/, "SJX"));
  let liveFlights = [];
  const liveUrl = new URL("https://fr24api.flightradar24.com/api/live/flight-positions/full");
  liveUrl.searchParams.set("flights", flightList.join(","));
  liveUrl.searchParams.set("callsigns", callsigns.join(","));
  liveUrl.searchParams.set("airports", "outbound:RCTP,inbound:RCTP");
  liveUrl.searchParams.set("limit", String(flightList.length));

  const liveResponse = await fetch(liveUrl, { headers: getFr24Headers(env) });

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

  const summaryResponse = await fetch(summaryUrl, { headers: getFr24Headers(env) });

  if (!summaryResponse.ok) {
    return {
      available: false,
      reason: `FR24 API returned HTTP ${summaryResponse.status}`,
      flights: cached?.payload?.flights || liveFlights,
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

async function fetchTdxFlightsByNumber(flights, env, force = false) {
  const flightList = parseFlightList(flights);
  const cacheKey = getFlightCacheKey(flightList);
  const cached = apiCache.tdxFlights.get(cacheKey);

  if (flightList.length === 0) {
    return new Response("[]", {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (!force && isFreshCache(cached, TDX_CACHE_MAX_AGE)) {
    return new Response(cached.body, {
      status: cached.status,
      headers: {
        "content-type": cached.contentType,
        "cache-control": "no-store",
        "x-starlux-cache": "hit",
        "x-starlux-updated-at": new Date(cached.savedAt).toISOString(),
      },
    });
  }

  const headers = { accept: "application/json" };
  const token = await getTdxAccessToken(env);

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const flightFilters = flightList
    .map((flight) => `FlightNumber eq '${getFlightNumber(flight)}'`)
    .join(" or ");
  const url = new URL("https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Flight");
  url.searchParams.set("IsCargo", "false");
  url.searchParams.set("$filter", `AirlineID eq 'JX' and (${flightFilters})`);
  url.searchParams.set("$top", "100");
  url.searchParams.set("$format", "JSON");

  const tdxResponse = await fetch(url, { headers });
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

  return new Response(text, {
    status: tdxResponse.status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-starlux-cache": "miss",
      "x-starlux-updated-at": new Date(updatedAt).toISOString(),
    },
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname;

  try {
    if (path === "/api/fr24/flights") {
      return jsonResponse(200, await fetchFr24FlightsByNumber(
        url.searchParams.get("flights") || "",
        context.env,
        url.searchParams.get("force") === "1",
      ));
    }

    if (path === "/api/tdx/fids/flights") {
      return fetchTdxFlightsByNumber(
        url.searchParams.get("flights") || "",
        context.env,
        url.searchParams.get("force") === "1",
      );
    }

    return jsonResponse(404, { error: "API route not found" });
  } catch (error) {
    return jsonResponse(502, {
      error: error instanceof Error ? error.message : "Unknown Cloudflare API error",
    });
  }
}
