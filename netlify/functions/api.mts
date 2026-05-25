declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

type CacheEntry<T> = {
  savedAt: number;
  payload: T;
};

type TdxCacheEntry = {
  savedAt: number;
  status: number;
  contentType: string;
  body: string;
};

type ApiCache = {
  tdx: TdxCacheEntry | null;
  tdxAccessToken: {
    token: string;
    expiresAt: number;
  } | null;
  fr24Live: CacheEntry<Record<string, unknown>> | null;
  fr24Summary: Map<string, CacheEntry<Record<string, unknown>>>;
};

const TDX_CACHE_MAX_AGE = 15 * 60 * 1000;
const FR24_LIVE_CACHE_MAX_AGE = 2 * 60 * 1000;
const FR24_SUMMARY_CACHE_MAX_AGE = 15 * 60 * 1000;

function getApiCache() {
  const store = globalThis as typeof globalThis & {
    __starluxApiCache?: ApiCache;
  };

  if (!store.__starluxApiCache) {
    store.__starluxApiCache = {
      tdx: null,
      tdxAccessToken: null,
      fr24Live: null,
      fr24Summary: new Map(),
    };
  }

  return store.__starluxApiCache;
}

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isFreshCache<T extends { savedAt: number }>(entry: T | null | undefined, maxAge: number) {
  return Boolean(entry && Date.now() - entry.savedAt < maxAge);
}

function getFr24Token() {
  return Netlify.env.get("FR24_API_TOKEN");
}

function getTdxToken() {
  return Netlify.env.get("TDX_API_TOKEN") || Netlify.env.get("TDX_API_KEY");
}

function getTdxClientId() {
  return Netlify.env.get("TDX_CLIENT_ID");
}

function getTdxClientSecret() {
  return Netlify.env.get("TDX_CLIENT_SECRET");
}

function getFr24Headers() {
  return {
    accept: "application/json",
    "accept-version": "v1",
    authorization: `Bearer ${getFr24Token()}`,
  };
}

async function getTdxAccessToken() {
  const staticToken = getTdxToken();
  const clientId = getTdxClientId();
  const clientSecret = getTdxClientSecret();
  const apiCache = getApiCache();

  if (!clientId || !clientSecret) {
    return staticToken || "";
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
      client_id: clientId,
      client_secret: clientSecret,
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

function normalizeFr24Flight(flight: Record<string, any>) {
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

function normalizeFr24SummaryFlight(flight: Record<string, any>) {
  return {
    fr24Id: flight.fr24_id || flight.flight_id || flight.id || "",
    flight: flight.flight || flight.callsign || "",
    aircraft: flight.type || flight.aircraft || "",
    registration: flight.reg || flight.registration || "",
  };
}

async function fetchFr24LiveStarlux() {
  const apiCache = getApiCache();

  if (isFreshCache(apiCache.fr24Live, FR24_LIVE_CACHE_MAX_AGE)) {
    return { ...apiCache.fr24Live.payload, cached: true };
  }

  if (!getFr24Token()) {
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

async function fetchFr24FlightSummary(ids: string) {
  const apiCache = getApiCache();

  if (!getFr24Token()) {
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

  const cachedFlights: Record<string, unknown>[] = [];
  const missingFlightIds: string[] = [];

  for (const id of flightIds) {
    const cached = apiCache.fr24Summary.get(id);

    if (isFreshCache(cached, FR24_SUMMARY_CACHE_MAX_AGE)) {
      cachedFlights.push(cached.payload);
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
    apiCache.fr24Summary.set(flight.fr24Id, { savedAt: Date.now(), payload: flight });
  }

  return {
    available: true,
    flights: [...cachedFlights, ...flights],
    sourceUpdatedAt: new Date().toISOString(),
  };
}

async function handleFr24LiveRequest() {
  const apiCache = getApiCache();

  try {
    return jsonResponse(200, await fetchFr24LiveStarlux());
  } catch (error) {
    if (apiCache.fr24Live) {
      return jsonResponse(200, {
        ...apiCache.fr24Live.payload,
        cached: "stale",
        reason: error instanceof Error ? error.message : "Unknown FR24 proxy error",
      });
    }

    return jsonResponse(502, {
      available: false,
      reason: error instanceof Error ? error.message : "Unknown FR24 proxy error",
      flights: [],
    });
  }
}

async function handleFr24SummaryRequest(request: Request) {
  try {
    const url = new URL(request.url);
    return jsonResponse(200, await fetchFr24FlightSummary(url.searchParams.get("ids") || ""));
  } catch (error) {
    return jsonResponse(502, {
      available: false,
      reason: error instanceof Error ? error.message : "Unknown FR24 summary proxy error",
      flights: [],
    });
  }
}

async function handleTdxRequest() {
  const apiCache = getApiCache();

  try {
    if (isFreshCache(apiCache.tdx, TDX_CACHE_MAX_AGE)) {
      return new Response(apiCache.tdx.body, {
        status: apiCache.tdx.status,
        headers: {
          "content-type": apiCache.tdx.contentType,
          "cache-control": "no-store",
          "x-starlux-cache": "hit",
        },
      });
    }

    const headers: Record<string, string> = { accept: "application/json" };
    const token = await getTdxAccessToken();

    if (token) {
      headers.authorization = `Bearer ${token}`;
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

    return new Response(text, {
      status: tdxResponse.status,
      headers: {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-starlux-cache": "miss",
      },
    });
  } catch (error) {
    if (apiCache.tdx) {
      return new Response(apiCache.tdx.body, {
        status: apiCache.tdx.status,
        headers: {
          "content-type": apiCache.tdx.contentType,
          "cache-control": "no-store",
          "x-starlux-cache": "stale",
        },
      });
    }

    return jsonResponse(502, {
      error: error instanceof Error ? error.message : "Unknown TDX proxy error",
    });
  }
}

export default async (request: Request) => {
  const url = new URL(request.url);

  if (url.pathname === "/api/fr24/starlux-live") {
    return handleFr24LiveRequest();
  }

  if (url.pathname === "/api/fr24/flight-summary") {
    return handleFr24SummaryRequest(request);
  }

  if (url.pathname === "/api/tdx/fids/tpe") {
    return handleTdxRequest();
  }

  return jsonResponse(404, { error: "API route not found" });
};

export const config = {
  path: [
    "/api/fr24/starlux-live",
    "/api/fr24/flight-summary",
    "/api/tdx/fids/tpe",
  ],
};
