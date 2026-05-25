const OFFICIAL_FLIGHT_TEXT_URL =
  "https://www.taoyuan-airport.com/uploads/flightx/a_flight_v4.txt";

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += char;
    }
  }

  values.push(value.trim());
  return values;
}

function normalizeDate(value) {
  return value.replaceAll("/", "-").slice(0, 10);
}

function normalizeTime(value) {
  return value.slice(0, 5);
}

function formatFlightNo(airlineCode, flightNo) {
  const raw = flightNo.trim();

  if (/^[A-Z]{2}\d+$/i.test(raw)) {
    return raw.toUpperCase().replace(/^JX0+/, "JX");
  }

  return `${airlineCode}${raw}`.toUpperCase().replace(/^JX0+/, "JX");
}

function parseTaoyuanFlights(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseCsvLine)
    .filter((fields) => fields.length >= 14)
    .filter((fields) => {
      const airlineCode = fields[2]?.toUpperCase();
      const airlineName = fields[3] || "";
      const flightNo = fields[4]?.toUpperCase() || "";
      return airlineCode === "JX" || airlineName.includes("星宇") || flightNo.startsWith("JX");
    })
    .map((fields) => ({
      type: fields[1] === "A" ? "抵達" : "起飛",
      flight: formatFlightNo(fields[2] || "JX", fields[4] || ""),
      city: fields[12] || fields[11] || fields[10] || "--",
      targetDate: normalizeDate(fields[8] || fields[6]),
      targetTime: normalizeTime(fields[9] || fields[7]),
      rawStatus: fields[13] || "",
      terminal: fields[0] || "",
      gate: fields[5] || "",
      sourceUpdatedAt: new Date().toISOString(),
    }));
}

function decodeFlightText(buffer) {
  const utf8Text = new TextDecoder("utf-8").decode(buffer);

  if (!utf8Text.includes("\uFFFD")) {
    return utf8Text;
  }

  return new TextDecoder("big5").decode(buffer);
}

const response = await fetch(`${OFFICIAL_FLIGHT_TEXT_URL}?t=${Date.now()}`, {
  cache: "no-store",
});

if (!response.ok) {
  throw new Error(`桃園機場航班資料讀取失敗：HTTP ${response.status}`);
}

const text = decodeFlightText(await response.arrayBuffer());
const flights = parseTaoyuanFlights(text);

await import("node:fs/promises").then((fs) =>
  fs.writeFile("taoyuan-flights.json", JSON.stringify(flights, null, 2)),
);

console.log(`Saved ${flights.length} StarLux flights to taoyuan-flights.json`);
