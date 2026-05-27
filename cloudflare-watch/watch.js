const TDX_TRACKED_URL = "/api/tdx/fids/flights";
const FR24_TRACKED_URL = "/api/fr24/flights";
const WATCH_STORAGE_KEY = "starlux-watch-flights-v1";
const FR24_CACHE_MAX_AGE = 30 * 60 * 1000;
const FORCE_REFRESH_COOLDOWN = 5 * 60 * 1000;

const airportCityNames = {
  AUH: "阿布達比",
  BKK: "曼谷",
  CEB: "宿霧",
  CGK: "雅加達",
  CNX: "清邁",
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
  RMQ: "台中",
  SDJ: "仙台",
  SEA: "西雅圖",
  SFO: "舊金山",
  SGN: "胡志明市",
  SHI: "宮古(下地島)",
  SIN: "新加坡",
  TPE: "台北桃園",
  UKB: "神戶",
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
const watchForm = document.querySelector("#watchForm");
const flightInput = document.querySelector("#flightInput");
const watchListElement = document.querySelector("#watchList");
const updatedAtElement = document.querySelector("#updatedAt");
const fr24UpdatedAtElement = document.querySelector("#fr24UpdatedAt");
const tdxLastUpdatedAtElement = document.querySelector("#tdxLastUpdatedAt");
const fr24LastUpdatedAtElement = document.querySelector("#fr24LastUpdatedAt");
const forceRefreshButton = document.querySelector("#forceRefreshButton");
const forceRefreshStatusElement = document.querySelector("#forceRefreshStatus");

let trackedFlightCodes = readTrackedFlightCodes();
let flights = [];
let fr24Flights = [];
let nextTdxRefreshAt = getNextMinuteBoundary(15);
let nextFr24RefreshAt = getNextMinuteBoundary(30);
let lastTdxRefreshAt = null;
let lastFr24RefreshAt = null;
let forceRefreshCooldownUntil = null;
let isTdxRefreshing = false;
let isFr24Refreshing = false;

flightInput.value = trackedFlightCodes.join(",");

function normalizeFlightCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^SJX0*/, "JX")
    .replace(/^JX0+/, "JX");
}

function parseFlightCodes(value) {
  return [...new Set(String(value || "")
    .split(",")
    .map(normalizeFlightCode)
    .filter((flight) => /^JX\d+$/.test(flight)))]
    .slice(0, 15);
}

function readTrackedFlightCodes() {
  try {
    return parseFlightCodes(JSON.parse(localStorage.getItem(WATCH_STORAGE_KEY) || "[]").join(","));
  } catch {
    return [];
  }
}

function writeTrackedFlightCodes(nextFlights) {
  localStorage.setItem(WATCH_STORAGE_KEY, JSON.stringify(nextFlights));
}

function getNextMinuteBoundary(intervalMinutes, from = new Date()) {
  const next = new Date(from);
  next.setSeconds(0, 0);

  const nextMinute = Math.ceil((next.getMinutes() + 0.001) / intervalMinutes) * intervalMinutes;

  if (nextMinute >= 60) {
    next.setHours(next.getHours() + 1, 0, 0, 0);
  } else {
    next.setMinutes(nextMinute, 0, 0);
  }

  return next;
}

function normalizeDate(value) {
  const match = String(value || "").match(/\d{4}[-/]\d{2}[-/]\d{2}/);
  return match ? match[0].replaceAll("/", "-") : "";
}

function normalizeTime(value) {
  const match = String(value || "").match(/\d{2}:\d{2}/);
  return match ? match[0] : "";
}

function formatFlightNo(airlineCode, flightNo) {
  const raw = String(flightNo || "").trim();

  if (/^[A-Z]{2}\d+$/i.test(raw)) {
    return normalizeFlightCode(raw);
  }

  return normalizeFlightCode(`${airlineCode}${raw}`);
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

function isTaipeiAirport(value) {
  return ["TPE", "RCTP"].includes(String(value || "").toUpperCase());
}

function getAircraftDisplayName(value) {
  if (value === "A21N") return "A321";
  if (value === "A321-252") return "A321";
  if (value === "A330-900") return "A339";
  if (value === "A350-900") return "A359";
  if (value === "A350-100") return "A35K";
  return value || "--";
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

function formatClock(date) {
  return formatter.format(date);
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
      getFirstValue(flight, ["FlightNumber", "FlightNo", "FlightID"]) || "",
    ),
    city: getCityName(airportId),
    gate: getFirstValue(flight, [
      type === "抵達" ? "ArrivalGate" : "DepartureGate",
      "Gate",
      "BoardingGate",
    ]) || "--",
    aircraft: getFirstValue(flight, ["AcType", "AircraftType", "Aircraft"]) || "",
    targetDate: normalizeDate(rawDate),
    scheduledTime: normalizeTime(rawScheduledTime),
    estimatedTime: normalizeTime(rawEstimatedTime),
    targetTime: normalizeTime(rawTime),
    rawStatus,
    sourceUpdatedAt: getFirstValue(flight, ["UpdateTime", "SrcUpdateTime"]) || new Date().toISOString(),
  };
}

function getScheduleDeltaStatus(flight, comparisonDateTime) {
  if (!flight.scheduledTime) return "";

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

function mapFlightStatus(rawStatus) {
  const status = String(rawStatus || "").toLowerCase();

  if (status.includes("取消") || status.includes("cancel")) return "延誤";
  if (status.includes("延誤") || status.includes("delay")) return "延誤";
  return "準時";
}

function getStatusClass(status) {
  if (status === "提前") return "early";
  if (status === "延遲") return "delayed";
  if (status === "延誤") return "delayed";
  return "scheduled";
}

function buildNextDayPreviewFlights(sourceFlights) {
  const existingFlights = new Set(sourceFlights.map((flight) => `${flight.targetDate}-${flight.flight}`));

  return sourceFlights
    .filter((flight) => {
      if (!flight.scheduledTime) return false;

      const scheduledHour = Number(flight.scheduledTime.split(":")[0]);
      const rawStatus = flight.rawStatus || "";

      if (flight.type === "起飛") {
        return scheduledHour >= 0 && scheduledHour < 3 && /出發|depart/i.test(rawStatus);
      }

      if (flight.type === "抵達") {
        return scheduledHour >= 3 && scheduledHour < 8 && /抵達|arriv/i.test(rawStatus);
      }

      return false;
    })
    .map((flight) => ({
      ...flight,
      targetDate: addDays(flight.targetDate, 1),
      estimatedTime: flight.estimatedTime || flight.scheduledTime,
      targetTime: flight.estimatedTime || flight.scheduledTime,
      rawStatus: "隔日預告",
      sourceUpdatedAt: new Date().toISOString(),
      nextDayPreview: true,
    }))
    .filter((flight) => !existingFlights.has(`${flight.targetDate}-${flight.flight}`));
}

function getFr24FlightMap() {
  const flightMap = new Map();

  for (const flight of fr24Flights) {
    for (const code of [flight.flight, flight.callsign]) {
      const normalizedCode = normalizeFlightCode(code);

      if (normalizedCode) {
        flightMap.set(normalizedCode, flight);
      }
    }
  }

  return flightMap;
}

function mapFr24TrackedFlight(flight, now) {
  const normalizedFlight = normalizeFlightCode(flight.flight || flight.callsign);
  const origin = String(flight.origin || "").toUpperCase();
  const destination = String(flight.destination || "").toUpperCase();
  const etaDateTime = flight.eta ? new Date(flight.eta) : null;

  if (!normalizedFlight || !etaDateTime || Number.isNaN(etaDateTime.getTime())) {
    return null;
  }

  const type = isTaipeiAirport(destination) ? "抵達" : "起飛";
  const cityCode = type === "抵達" ? origin : destination;
  const targetDate = dateFormatter.format(etaDateTime);
  const minutes = Math.ceil((etaDateTime - now) / 60000);

  if (minutes <= 0) {
    return null;
  }

  return {
    type,
    flight: normalizedFlight,
    city: getCityName(cityCode),
    gate: "--",
    aircraft: flight.aircraft || "",
    targetDate,
    scheduledTime: "",
    estimatedTime: formatClock(etaDateTime),
    targetTime: formatClock(etaDateTime),
    targetDateTime: etaDateTime,
    scheduledDateTime: etaDateTime,
    minutes,
    status: "追蹤中",
    displayEstimatedTime: formatClock(etaDateTime),
    timeSource: "FR24 ETA",
    sourceUpdatedAt: flight.updatedAt || new Date().toISOString(),
    fr24Only: true,
  };
}

function getFr24OnlyFlights(now, activeFlightCodes) {
  return fr24Flights
    .map((flight) => mapFr24TrackedFlight(flight, now))
    .filter(Boolean)
    .filter((flight) => trackedFlightCodes.includes(flight.flight))
    .filter((flight) => !activeFlightCodes.has(flight.flight));
}

function filterCurrentFlights(mappedFlights, now, trackingMap) {
  const today = dateFormatter.format(now);
  const tomorrow = getTomorrowDate(now);

  const currentFlights = mappedFlights
    .filter((flight) => [today, tomorrow].includes(flight.targetDate))
    .map((flight) => {
      const trackedFlight = trackingMap.get(flight.flight);
      const fr24Eta = trackedFlight?.eta ? new Date(trackedFlight.eta) : null;
      const hasFr24Eta = flight.type === "抵達"
        && fr24Eta
        && !Number.isNaN(fr24Eta.getTime());
      const fr24TargetDate = hasFr24Eta ? dateFormatter.format(fr24Eta) : "";
      const targetDateTime = hasFr24Eta
        ? fr24Eta
        : getTaipeiDate(flight.targetDate, flight.targetTime);
      const minutes = Math.ceil((targetDateTime - now) / 60000);
      const comparisonFlight = hasFr24Eta
        ? { ...flight, targetDate: fr24TargetDate }
        : flight;
      const deltaStatus = getScheduleDeltaStatus(comparisonFlight, targetDateTime);
      const status = deltaStatus || flight.status || mapFlightStatus(flight.rawStatus);
      const displayDate = hasFr24Eta ? fr24TargetDate : flight.targetDate;

      return {
        ...flight,
        targetDate: displayDate,
        targetDateTime,
        scheduledDateTime: getTaipeiDate(displayDate, flight.scheduledTime || flight.targetTime),
        minutes,
        status,
        displayEstimatedTime: hasFr24Eta ? formatClock(fr24Eta) : flight.estimatedTime || flight.targetTime,
        timeSource: hasFr24Eta ? "FR24 ETA" : "TDX",
      };
    })
    .filter((flight) => !Number.isNaN(flight.targetDateTime.getTime()))
    .filter((flight) => flight.minutes > 0);

  const uniqueFlights = new Map();

  for (const flight of currentFlights) {
    const key = `${flight.type}-${flight.flight}-${flight.targetDate}`;
    const existingFlight = uniqueFlights.get(key);

    if (!existingFlight || (existingFlight.nextDayPreview && !flight.nextDayPreview)) {
      uniqueFlights.set(key, flight);
    }
  }

  return [...uniqueFlights.values()]
    .sort((a, b) => {
      if (a.targetDate !== b.targetDate) {
        return a.targetDate.localeCompare(b.targetDate);
      }

      return a.scheduledDateTime - b.scheduledDateTime;
    });
}

async function fetchTdxFlights(force = false) {
  if (trackedFlightCodes.length === 0) {
    return [];
  }

  const params = new URLSearchParams({ flights: trackedFlightCodes.join(",") });
  if (force) params.set("force", "1");

  const response = await fetch(`${TDX_TRACKED_URL}?${params}`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Unable to load tracked TDX flights");
  }

  const responseUpdatedAt = response.headers.get("x-starlux-updated-at");
  const payload = await response.json();
  const tdxFlights = Array.isArray(payload)
    ? payload
      .flatMap((flight) => [
        flight.DepartureAirportID === "TPE" ? mapTdxFlight(flight, "起飛") : null,
        flight.ArrivalAirportID === "TPE" ? mapTdxFlight(flight, "抵達") : null,
      ])
      .filter(Boolean)
    : [];
  const filteredFlights = tdxFlights
    .filter((flight) => trackedFlightCodes.includes(flight.flight) && flight.targetDate && flight.targetTime);
  const nextDayPreviewFlights = buildNextDayPreviewFlights(filteredFlights);

  lastTdxRefreshAt = responseUpdatedAt ? new Date(responseUpdatedAt) : new Date();
  return [...filteredFlights, ...nextDayPreviewFlights];
}

async function fetchFr24Flights(force = false) {
  if (trackedFlightCodes.length === 0) {
    return [];
  }

  const params = new URLSearchParams({ flights: trackedFlightCodes.join(",") });
  if (force) params.set("force", "1");

  const response = await fetch(`${FR24_TRACKED_URL}?${params}`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Unable to load tracked FR24 flights");
  }

  const payload = await response.json();
  lastFr24RefreshAt = payload.sourceUpdatedAt ? new Date(payload.sourceUpdatedAt) : new Date();
  nextFr24RefreshAt = getNextMinuteBoundary(30);
  return Array.isArray(payload.flights) ? payload.flights : [];
}

async function loadTdxFlights(force = false) {
  if (isTdxRefreshing) return;

  isTdxRefreshing = true;

  try {
    flights = await fetchTdxFlights(force);
  } catch {
    flights = [];
  } finally {
    isTdxRefreshing = false;
  }

  nextTdxRefreshAt = getNextMinuteBoundary(15);
  render();
}

async function refreshFr24Flights(force = false) {
  if (isFr24Refreshing) return;

  isFr24Refreshing = true;

  try {
    fr24Flights = await fetchFr24Flights(force);
  } catch {
    fr24Flights = [];
  } finally {
    isFr24Refreshing = false;
    render();
  }
}

async function loadFlights(force = false) {
  await refreshFr24Flights(force);
  await loadTdxFlights(force);
}

async function forceRefreshFlights() {
  if (forceRefreshCooldownUntil && Date.now() < forceRefreshCooldownUntil.getTime()) {
    render();
    return;
  }

  forceRefreshButton.disabled = true;
  forceRefreshButton.textContent = "更新中";
  forceRefreshStatusElement.textContent = "正在重新抓指定航班";

  try {
    await loadFlights(true);
    forceRefreshCooldownUntil = new Date(Date.now() + FORCE_REFRESH_COOLDOWN);
    forceRefreshStatusElement.textContent = `更新完成 ${formatClock(new Date())}`;
  } catch {
    forceRefreshStatusElement.textContent = "更新失敗，保留目前資料";
  } finally {
    forceRefreshButton.disabled = false;
    forceRefreshButton.textContent = "強制更新";
  }
}

async function refreshTdxFlightsIfDue() {
  if (Date.now() < nextTdxRefreshAt.getTime()) return;
  await loadTdxFlights();
}

async function refreshFr24FlightsIfDue() {
  if (Date.now() < nextFr24RefreshAt.getTime()) return;
  await refreshFr24Flights();
}

function renderWatchList() {
  watchListElement.textContent = trackedFlightCodes.length > 0
    ? `目前追蹤 ${trackedFlightCodes.join(" / ")}`
    : "尚未設定追蹤航班";
}

function getWaitingRows(activeFlightCodes) {
  return trackedFlightCodes
    .filter((flight) => !activeFlightCodes.has(flight))
    .map((flight) => `
      <div class="flight-row waiting-row" role="row">
        <span class="flight-code arrival-flight is-empty" data-label="ARR" role="cell"></span>
        <span class="flight-code departure-flight" data-label="DEP" role="cell">${flight}</span>
        <span class="aircraft" data-label="TYPE" role="cell">--</span>
        <span class="city" data-label="IATA" role="cell">等待資料</span>
        <span class="gate" data-label="BAY" role="cell">--</span>
        <span class="schedule-time" data-label="STA" role="cell">--</span>
        <span class="estimate-time" data-label="STD" role="cell">--</span>
        <span class="minutes" data-label="倒數" role="cell">--</span>
        <span class="status-cell" data-label="狀態" role="cell">
          <span class="status tracking">等待</span>
        </span>
      </div>
    `);
}

function render() {
  const now = new Date();
  const tdxCurrentFlights = filterCurrentFlights(flights, now, getFr24FlightMap());
  const currentFlightCodes = new Set(tdxCurrentFlights.map((flight) => flight.flight));
  const currentFlights = [...tdxCurrentFlights, ...getFr24OnlyFlights(now, currentFlightCodes)]
    .sort((a, b) => {
      if (a.targetDate !== b.targetDate) {
        return a.targetDate.localeCompare(b.targetDate);
      }

      return a.scheduledDateTime - b.scheduledDateTime;
    });
  const nextFlight = currentFlights.find((flight) => flight.minutes > 0);
  const tdxRefreshMinutes = Math.max(0, Math.ceil((nextTdxRefreshAt - now) / 60000));
  const fr24RefreshMinutes = Math.max(0, Math.ceil((nextFr24RefreshAt - now) / 60000));
  const forceCooldownMinutes = forceRefreshCooldownUntil
    ? Math.max(0, Math.ceil((forceRefreshCooldownUntil - now) / 60000))
    : 0;

  renderWatchList();

  updatedAtElement.textContent = `${tdxRefreshMinutes} 分鐘`;
  fr24UpdatedAtElement.textContent = `${fr24RefreshMinutes} 分鐘`;
  tdxLastUpdatedAtElement.textContent = `上次更新 ${lastTdxRefreshAt ? formatClock(lastTdxRefreshAt) : "--:--"}`;
  fr24LastUpdatedAtElement.textContent = `上次更新 ${lastFr24RefreshAt ? formatClock(lastFr24RefreshAt) : "--:--"}`;

  if (forceCooldownMinutes > 0) {
    forceRefreshButton.disabled = true;
    forceRefreshButton.textContent = `${forceCooldownMinutes} 分鐘`;
    forceRefreshStatusElement.textContent = "強制更新冷卻中";
  } else if (!forceRefreshButton.disabled) {
    forceRefreshButton.textContent = "強制更新";
    if (!forceRefreshStatusElement.textContent.startsWith("更新完成")) {
      forceRefreshStatusElement.textContent = "只更新追蹤航班";
    }
  }

  if (trackedFlightCodes.length === 0) {
    rowsElement.innerHTML = `
      <div class="flight-row waiting-row" role="row">
        <span class="flight-code arrival-flight is-empty" data-label="ARR" role="cell"></span>
        <span class="flight-code departure-flight is-empty" data-label="DEP" role="cell"></span>
        <span class="aircraft" data-label="TYPE" role="cell">--</span>
        <span class="city" data-label="IATA" role="cell">請輸入航班</span>
        <span class="gate" data-label="BAY" role="cell">--</span>
        <span class="schedule-time" data-label="STA" role="cell">--</span>
        <span class="estimate-time" data-label="STD" role="cell">--</span>
        <span class="minutes" data-label="倒數" role="cell">--</span>
        <span class="status-cell" data-label="狀態" role="cell">
          <span class="status tracking">待設定</span>
        </span>
      </div>
    `;
    return;
  }

  const activeFlightCodes = new Set(currentFlights.map((flight) => flight.flight));
  const renderedRows = currentFlights.map((flight) => {
    const isNext = nextFlight && flight.flight === nextFlight.flight;
    const hasFr24Eta = flight.timeSource === "FR24 ETA";
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
        <span class="aircraft" data-label="TYPE" role="cell">${getAircraftDisplayName(flight.aircraft)}</span>
        <span class="city" data-label="IATA" role="cell">${flight.city}</span>
        <span class="gate" data-label="BAY" role="cell">${flight.gate || "--"}</span>
        <span class="schedule-time" data-label="STA" role="cell">${scheduledDisplayTime}</span>
        <span class="estimate-time" data-label="STD" role="cell">
          ${estimatedDisplayTime}
          ${hasFr24Eta ? `<small class="time-source">ETA</small>` : ""}
        </span>
        <span class="minutes" data-label="倒數" role="cell">${flight.minutes} 分鐘</span>
        <span class="status-cell" data-label="狀態" role="cell">
          <span class="status ${getStatusClass(flight.status)}">
            ${flight.status}
          </span>
        </span>
      </div>
    `;
  });

  rowsElement.innerHTML = [...renderedRows, ...getWaitingRows(activeFlightCodes)].join("");
}

watchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  trackedFlightCodes = parseFlightCodes(flightInput.value);
  flightInput.value = trackedFlightCodes.join(",");
  writeTrackedFlightCodes(trackedFlightCodes);
  forceRefreshStatusElement.textContent = "正在載入追蹤航班";
  void loadFlights(true);
});

forceRefreshButton.addEventListener("click", forceRefreshFlights);

render();
void loadFlights();
setInterval(render, 1000);
setInterval(refreshTdxFlightsIfDue, 1000);
setInterval(refreshFr24FlightsIfDue, 1000);
