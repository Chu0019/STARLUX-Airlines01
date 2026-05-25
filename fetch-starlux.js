const candidates = [
  "JX801",
  "JX751",
  "JX772",
  "JX742",
  "JX823",
  "JX9",
  "JX713",
  "JX717",
  "JX871",
  "JX838",
  "JX315",
  "JX804",
  "JX803",
  "JX851",
  "JX1",
  "JX303",
  "JX703",
  "JX11",
  "JX205",
  "JX31",
  "JX863",
  "JX2",
  "JX6",
  "JX10",
  "JX12",
  "JX32",
  "JX26",
  "JX25",
  "JX5",
];

const dates = ["2026-05-22", "2026-05-23"];
const endpoint = "https://ecapi.starlux-airlines.com/flightSchedule/v2/flight-status";

async function fetchFlight(flightNo, date) {
  const url = new URL(endpoint);
  url.searchParams.set("searchType", "flight-number");
  url.searchParams.set("date", date);
  url.searchParams.set("flightNo", flightNo);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Jx-Lang": "zh-TW",
    },
  });
  const payload = await response.json();

  if (!payload.success) {
    return [];
  }

  return payload.data.flights.map((flight) => ({
    ...flight,
    lastUpdateTimeLocal: payload.data.lastUpdateTimeLocal,
  }));
}

const flights = [];

for (const date of dates) {
  for (const flightNo of candidates) {
    try {
      flights.push(...await fetchFlight(flightNo, date));
    } catch {
      // Skip individual failures so the board can still use the rest.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const uniqueFlights = Array.from(
  new Map(
    flights
      .filter((flight) => flight.operatingAirlineCode === "JX")
      .map((flight) => [
        `${flight.flightNo}-${flight.scheduledDepartureDate}-${flight.scheduledDepartureTime}`,
        flight,
      ]),
  ).values(),
);

await import("node:fs/promises").then((fs) =>
  fs.writeFile("starlux-flights.json", JSON.stringify(uniqueFlights, null, 2)),
);

console.log(`Saved ${uniqueFlights.length} flights to starlux-flights.json`);
