const TDX_FIDS_TPE_URL = "/api/tdx/fids/tpe";
const FR24_LIVE_URL = "/api/fr24/starlux-live";
const FR24_SUMMARY_URL = "/api/fr24/flight-summary";
const CACHE_KEY = "starlux-tdx-fids-tpe-v7-next-day";
const FR24_CACHE_KEY = "starlux-fr24-live-v1";
const FR24_SUMMARY_CACHE_KEY = "starlux-fr24-summary-v1";
const CACHE_MAX_AGE = 15 * 60 * 1000;
const FR24_CACHE_MAX_AGE = 3 * 60 * 60 * 1000;
const FR24_SUMMARY_CACHE_MAX_AGE = 15 * 60 * 1000;

const fallbackFlights = [
  {
    type: "起飛",
    flight: "JX12",
    city: "舊金山",
    gate: "A8",
    targetDate: "2026-05-23",
    scheduledTime: "00:05",
    estimatedTime: "00:05",
    targetTime: "00:05",
    status: "準時",
    sourceUpdatedAt: "2026-05-22T23:33:17+08:00",
  },
  {
    type: "起飛",
    flight: "JX2",
    city: "洛杉磯",
    gate: "A9",
    targetDate: "2026-05-23",
    scheduledTime: "00:10",
    estimatedTime: "00:10",
    targetTime: "00:10",
    status: "準時",
    sourceUpdatedAt: "2026-05-22T23:33:17+08:00",
  },
  {
    type: "抵達",
    flight: "JX31",
    city: "西雅圖",
    gate: "--",
    targetDate: "2026-05-23",
    scheduledTime: "04:26",
    estimatedTime: "04:26",
    targetTime: "04:26",
    status: "準時",
    sourceUpdatedAt: "2026-05-22T23:33:17+08:00",
  },
];

const airportCityNames = {
  AUH: "阿布達比",
  BKK: "曼谷",
  CEB: "宿霧",
  CGK: "雅加達",
  CRK: "克拉克",
  CTS: "札幌",
  DAD: "峴港",
  FUK: "福岡",
  HAN: "河內",
  HKG: "香港",
  HKD: "函館",
  KIX: "大阪/關西",
  KMJ: "熊本",
  KUL: "吉隆坡",
  LAX: "洛杉磯",
  MFM: "澳門",
  MNL: "馬尼拉",
  NGO: "名古屋",
  NRT: "東京成田",
  OKA: "琉球(沖繩)",
  ONT: "安大略",
  PHX: "鳳凰城",
  PQC: "富國島",
  SDJ: "仙台",
  SEA: "西雅圖",
  SFO: "舊金山",
  SGN: "胡志明市",
  SIN: "新加坡",
  TPE: "台北桃園",
};

const formatter = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const rowsElement = document.querySelector("#flightRows");
const updatedAtElement = document.querySelector("#updatedAt");

let flights = fallbackFlights;
let dataSource = "備用資料";
let fr24Flights = [];
let nextDataRefreshAt = new Date(Date.now() + CACHE_MAX_AGE);

function normalizeDate(value) {
  const match = value.match(/\d{4}[-/]\d{2}[-/]\d{2}/);
  return match ? match[0].replaceAll("/", "-") : "";
}

function normalizeTime(value) {
  const match = value.match(/\d{2}:\d{2}/);
  return match ? match[0] : "";
}

function formatFlightNo(airlineCode, flightNo) {
  const raw = flightNo.trim();

  if (/^[A-Z]{2}\d+$/i.test(raw)) {
    return raw.toUpperCase().replace(/^JX0+/, "JX");
  }

  return `${airlineCode}${raw}`.toUpperCase().replace(/^JX0+/, "JX");
}

function getLocalizedText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.Zh_tw || value.ZhTW || value.Zh || value.En || "";
}

function getFirstValue(source, keys) {
  return keys.map((key) => source[key]).find((value) => value !== undefined && value !== null && value !== "");
}

function getCityName(value) {
  return airportCityNames[value] || value || "--";
}

function getAircraftDisplayName(value) {
  if (value === "A21N") return "A321";
  if (value === "A321-252") return "A321";
  if (value === "A330-900") return "A339";
  if (value === "A350-900") return "A359";
  if (value === "A350-100") return "A35K";
  return value || "--";
}

function getScheduleDeltaStatus(flight, comparisonDateTime) {
  if (!flight.scheduledTime) {
    return "";
  }

  const scheduledDateTime = getTaipeiDate(flight.targetDate, flight.scheduledTime);
  const estimatedDateTime = comparisonDateTime
    || (flight.estimatedTime ? getTaipeiDate(flight.targetDate, flight.estimatedTime) : null);

  if (!estimatedDateTime || Number.isNaN(estimatedDateTime.getTime())) {
    return "";
  }

  const deltaMinutes = Math.round((estimatedDateTime - scheduledDateTime) / 60000);

  if (deltaMinutes > 0) return "延遲";
  if (deltaMinutes < 0) return "提前";
  return "";
}

function mapFlightStatus(rawStatus, type, minutes) {
  const status = rawStatus.toLowerCase();

  if (status.includes("取消") || status.includes("cancel")) {
    return "延誤";
  }

  if (status.includes("延誤") || status.includes("delay")) {
    return "延誤";
  }

  return "準時";
}

function mapTdxFlight(flight, type) {
  const airportId = getFirstValue(flight, [
    type === "抵達" ? "DepartureAirportID" : "ArrivalAirportID",
    type === "抵達" ? "DepartureAirportCode" : "ArrivalAirportCode",
  ]);
  const rawScheduledTime = getFirstValue(flight, [
    type === "抵達" ? "ScheduleArrivalTime" : "ScheduleDepartureTime",
    "ScheduleTime",
  ]);
  const rawEstimatedTime = getFirstValue(flight, [
    type === "抵達" ? "EstimatedArrivalTime" : "EstimatedDepartureTime",
    "EstimatedTime",
  ]);
  const rawTime = rawEstimatedTime || rawScheduledTime;
  const rawStatus = getLocalizedText(
    getFirstValue(flight, [
      type === "抵達" ? "ArrivalRemark" : "DepartureRemark",
      "Remark",
      "FlightRemark",
    ]),
  );
  const rawDate = String(getFirstValue(flight, ["FlightDate", "ScheduleDate"]) || rawTime || "");

  return {
    type,
    flight: formatFlightNo(
      getFirstValue(flight, ["AirlineID", "AirlineIATA", "AirlineCode"]) || "JX",
      String(getFirstValue(flight, ["FlightNumber", "FlightNo", "FlightID"]) || ""),
    ),
    city: getCityName(airportId),
    terminal: getFirstValue(flight, [
      type === "抵達" ? "ArrivalTerminal" : "DepartureTerminal",
      "Terminal",
      "TerminalID",
    ]) || "--",
    gate: getFirstValue(flight, [
      type === "抵達" ? "ArrivalGate" : "DepartureGate",
      "Gate",
      "BoardingGate",
    ]) || "--",
    checkin: getFirstValue(flight, ["CheckCounter", "CheckInCounter"]) || "--",
    aircraft: getFirstValue(flight, ["AcType", "AircraftType", "Aircraft"]) || "",
    targetDate: normalizeDate(rawDate),
    scheduledTime: normalizeTime(String(rawScheduledTime || "")),
    estimatedTime: normalizeTime(String(rawEstimatedTime || "")),
    targetTime: normalizeTime(String(rawTime || "")),
    rawStatus,
    sourceUpdatedAt: getFirstValue(flight, ["UpdateTime", "SrcUpdateTime"]) || new Date().toISOString(),
  };
}

function readTdxCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");

    if (cached && Date.now() - cached.savedAt < CACHE_MAX_AGE) {
      return cached.flights;
    }
  } catch {
    return null;
  }

  return null;
}

function writeTdxCache(nextFlights) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), flights: nextFlights }),
    );
  } catch {
    // The board still works without localStorage cache.
  }
}

function readFr24Cache() {
  try {
    const cached = JSON.parse(localStorage.getItem(FR24_CACHE_KEY) || "null");

    if (cached && Date.now() - cached.savedAt < FR24_CACHE_MAX_AGE) {
      return cached.flights;
    }
  } catch {
    return null;
  }

  return null;
}

function writeFr24Cache(nextFlights) {
  try {
    localStorage.setItem(
      FR24_CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), flights: nextFlights }),
    );
  } catch {
    // The board can still use TDX without FR24 cache.
  }
}

function readFr24SummaryCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(FR24_SUMMARY_CACHE_KEY) || "null");

    if (!cached || typeof cached !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(cached).filter(([, value]) => (
        value
        && Date.now() - value.savedAt < FR24_SUMMARY_CACHE_MAX_AGE
      )),
    );
  } catch {
    return {};
  }
}

function writeFr24SummaryCache(summaryMap) {
  try {
    localStorage.setItem(FR24_SUMMARY_CACHE_KEY, JSON.stringify(summaryMap));
  } catch {
    // Summary data is optional; the board still works without it.
  }
}

function getTaipeiDate(date, time) {
  return new Date(`${date}T${time}:00+08:00`);
}

function addDays(dateText, days) {
  const date = getTaipeiDate(dateText, "00:00");
  date.setDate(date.getDate() + days);
  return dateFormatter.format(date);
}

function getTomorrowDate(now) {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return dateFormatter.format(tomorrow);
}

function getFr24FlightMap() {
  return new Map(fr24Flights.map((flight) => [flight.flight, flight]));
}

function chunkItems(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

async function hydrateFr24Registrations(nextFlights) {
  const missingSummaryIds = nextFlights
    .filter((flight) => flight.fr24Id && !flight.registration)
    .map((flight) => flight.fr24Id);

  if (missingSummaryIds.length === 0) {
    return nextFlights;
  }

  const summaryCache = readFr24SummaryCache();
  const idsToFetch = [...new Set(missingSummaryIds)]
    .filter((id) => !summaryCache[id]?.registration);

  for (const ids of chunkItems(idsToFetch, 10)) {
    try {
      const response = await fetch(`${FR24_SUMMARY_URL}?ids=${encodeURIComponent(ids.join(","))}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const summaryFlights = Array.isArray(payload.flights) ? payload.flights : [];

      for (const flight of summaryFlights) {
        if (!flight.fr24Id) continue;

        summaryCache[flight.fr24Id] = {
          aircraft: flight.aircraft || "",
          registration: flight.registration || "",
          savedAt: Date.now(),
        };
      }
    } catch (error) {
      console.warn("Unable to load FR24 flight summary", error);
    }
  }

  writeFr24SummaryCache(summaryCache);

  return nextFlights.map((flight) => {
    const summaryFlight = summaryCache[flight.fr24Id];

    if (!summaryFlight) {
      return flight;
    }

    return {
      ...flight,
      aircraft: flight.aircraft || summaryFlight.aircraft || "",
      registration: flight.registration || summaryFlight.registration || "",
    };
  });
}

function formatClock(date) {
  return formatter.format(date);
}

function getStatusClass(status) {
  if (status === "提前") return "early";
  if (status === "延遲") return "delayed";
  if (status === "延誤") return "delayed";
  if (status === "追蹤中") return "tracking";
  return "scheduled";
}

function filterCurrentFlights(mappedFlights, now, trackingMap) {
  const today = dateFormatter.format(now);
  const tomorrow = getTomorrowDate(now);

  return mappedFlights
    .filter((flight) => [today, tomorrow].includes(flight.targetDate))
    .map((flight) => {
      const trackedFlight = trackingMap.get(flight.flight);
      const fr24Eta = trackedFlight?.eta ? new Date(trackedFlight.eta) : null;
      const hasFr24Eta = flight.type === "抵達"
        && fr24Eta
        && !Number.isNaN(fr24Eta.getTime());
      const targetDateTime = hasFr24Eta
        ? fr24Eta
        : getTaipeiDate(flight.targetDate, flight.targetTime);
      const rawMinutes = Math.ceil((targetDateTime - now) / 60000);
      const minutes = rawMinutes;
      const deltaStatus = getScheduleDeltaStatus(flight, targetDateTime);
      const status = deltaStatus || flight.status || mapFlightStatus(flight.rawStatus || "", flight.type, minutes);
      return {
        ...flight,
        targetDateTime,
        minutes,
        status,
        displayEstimatedTime: hasFr24Eta ? formatClock(fr24Eta) : flight.estimatedTime || flight.targetTime,
        timeSource: hasFr24Eta ? "FR24 ETA" : "TDX",
      };
    })
    .filter((flight) => !Number.isNaN(flight.targetDateTime.getTime()))
    .filter((flight) => flight.minutes > 0)
    .sort((a, b) => a.targetDateTime - b.targetDateTime);
}

async function fetchTdxFlights() {
  try {
    const response = await fetch(TDX_FIDS_TPE_URL, { cache: "no-store" });

    if (!response.ok) {
      throw new Error("Unable to load TDX FIDS flights");
    }

    const payload = await response.json();
    const airportFids = Array.isArray(payload) ? payload[0] : payload;
    const tdxFlights = (Array.isArray(payload) && payload.some((flight) => flight.AirlineID))
      ? payload
        .flatMap((flight) => [
          flight.DepartureAirportID === "TPE" ? mapTdxFlight(flight, "起飛") : null,
          flight.ArrivalAirportID === "TPE" ? mapTdxFlight(flight, "抵達") : null,
        ])
        .filter(Boolean)
      : [
        ...(airportFids?.FIDSDeparture || []).map((flight) => mapTdxFlight(flight, "起飛")),
        ...(airportFids?.FIDSArrival || []).map((flight) => mapTdxFlight(flight, "抵達")),
      ];

    const filteredFlights = tdxFlights
      .filter((flight) => flight.flight.startsWith("JX") && flight.targetDate && flight.targetTime);
    const nextDayPreviewFlights = buildNextDayPreviewFlights(filteredFlights);
    const displayFlights = [...filteredFlights, ...nextDayPreviewFlights];

    if (displayFlights.length === 0) {
      throw new Error("TDX returned no StarLux flights");
    }

    writeTdxCache(displayFlights);
    dataSource = "TDX 即時航班";
    return displayFlights;
  } catch (error) {
    const cached = readTdxCache();

    if (cached) {
      dataSource = "TDX 本機快取";
      return cached;
    }

    throw error;
  }
}

function buildNextDayPreviewFlights(sourceFlights) {
  const existingFlights = new Set(sourceFlights.map((flight) => `${flight.targetDate}-${flight.flight}`));

  return sourceFlights
    .filter((flight) => {
      if (flight.type !== "起飛") return false;
      if (!flight.scheduledTime) return false;

      const scheduledHour = Number(flight.scheduledTime.split(":")[0]);
      const isEarlyMorningDeparture = scheduledHour >= 0 && scheduledHour < 3;
      const isCompleted = /出發|depart/i.test(flight.rawStatus || "");

      return isEarlyMorningDeparture && isCompleted;
    })
    .map((flight) => ({
      ...flight,
      targetDate: addDays(flight.targetDate, 1),
      estimatedTime: flight.scheduledTime,
      targetTime: flight.scheduledTime,
      rawStatus: "隔日預告",
      status: "準時",
      sourceUpdatedAt: new Date().toISOString(),
      nextDayPreview: true,
    }))
    .filter((flight) => !existingFlights.has(`${flight.targetDate}-${flight.flight}`));
}

async function fetchFr24Flights() {
  try {
    const response = await fetch(FR24_LIVE_URL, { cache: "no-store" });

    if (!response.ok) {
      throw new Error("Unable to load FR24 live flights");
    }

    const payload = await response.json();
    const nextFr24Flights = Array.isArray(payload.flights)
      ? payload.flights
      : [];

    if (payload.available && nextFr24Flights.length > 0) {
      fr24Flights = nextFr24Flights;
      writeFr24Cache(fr24Flights);
    }
  } catch {
    if (fr24Flights.length > 0) {
      return;
    }

    const cached = readFr24Cache();

    if (cached) {
      fr24Flights = cached;
    }
  }
}

async function loadFlights() {
  await fetchFr24Flights();

  try {
    flights = await fetchTdxFlights();
  } catch {
    flights = fallbackFlights;
    dataSource = "備用資料";
  }

  nextDataRefreshAt = new Date(Date.now() + CACHE_MAX_AGE);
  render();
}

async function refreshFr24Flights() {
  await fetchFr24Flights();
  render();
}

function render() {
  const now = new Date();
  const fr24FlightMap = getFr24FlightMap();
  const currentFlights = filterCurrentFlights(flights, now, fr24FlightMap);
  const nextFlight = currentFlights.find((flight) => flight.minutes > 0);
  const sourceUpdatedAt = currentFlights[0]?.sourceUpdatedAt
    ? new Date(currentFlights[0].sourceUpdatedAt)
    : now;

  const refreshMinutes = Math.max(0, Math.ceil((nextDataRefreshAt - now) / 60000));

  updatedAtElement.textContent = `${refreshMinutes} 分鐘`;

  rowsElement.innerHTML = currentFlights
    .map((flight) => {
      const isNext = nextFlight && flight.flight === nextFlight.flight;
      const countdownText = `${flight.minutes} 分鐘`;
      const hasFr24Eta = flight.type === "抵達" && flight.timeSource === "FR24 ETA";
      const aircraft = getAircraftDisplayName(flight.aircraft);
      const scheduledDisplayTime = flight.type === "起飛"
        ? flight.displayEstimatedTime || "--"
        : flight.scheduledTime || "--";
      const estimatedDisplayTime = flight.type === "起飛"
        ? flight.scheduledTime || "--"
        : flight.displayEstimatedTime || "--";

      return `
        <div class="flight-row ${isNext ? "is-next" : ""}" role="row">
          <span class="flight-code arrival-flight ${flight.type === "抵達" ? "" : "is-empty"}" data-label="ARR" role="cell">
            ${flight.type === "抵達" ? flight.flight : ""}
          </span>
          <span class="flight-code departure-flight ${flight.type === "起飛" ? "" : "is-empty"}" data-label="DEP" role="cell">
            ${flight.type === "起飛" ? flight.flight : ""}
          </span>
          <span class="aircraft" data-label="TYPE" role="cell">${aircraft}</span>
          <span class="city" data-label="IATA" role="cell">${flight.city}</span>
          <span class="gate" data-label="BAY" role="cell">${flight.gate || "--"}</span>
          <span class="schedule-time" data-label="STA" role="cell">
            ${scheduledDisplayTime}
            ${flight.type === "起飛" && flight.timeSource === "FR24 ETA" ? `<small class="time-source">ETA</small>` : ""}
          </span>
          <span class="estimate-time" data-label="STD" role="cell">
            ${estimatedDisplayTime}
            ${flight.type === "抵達" && flight.timeSource === "FR24 ETA" ? `<small class="time-source">ETA</small>` : ""}
          </span>
          <span class="minutes ${flight.minutes <= 0 ? "arrived" : ""}" data-label="倒數" role="cell">
            ${countdownText}
          </span>
          <span class="status-cell" data-label="狀態" role="cell">
            <span class="status ${getStatusClass(flight.status)}">
              ${flight.status}${hasFr24Eta ? "<small>FR24 ETA</small>" : ""}
            </span>
          </span>
        </div>
      `;
    })
    .join("");

  void sourceUpdatedAt;
}

loadFlights();

function scheduleMinuteRender() {
  const now = new Date();
  const delay = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());

  setTimeout(() => {
    render();
    setInterval(render, 60000);
  }, delay);
}

scheduleMinuteRender();
setInterval(loadFlights, CACHE_MAX_AGE);
setInterval(refreshFr24Flights, FR24_CACHE_MAX_AGE);
