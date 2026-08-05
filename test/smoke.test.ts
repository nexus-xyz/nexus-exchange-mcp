import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_URL_ENV,
  SmokeConfigError,
  SmokeResponseError,
  assertMarketPayload,
  containsMarkup,
  looksLikeMarkup,
  resolveTarget,
} from "../scripts/smoke.js";

/**
 * Guards for the `npm run smoke` target resolution and payload validation
 * (ENG-8092). The script previously defaulted to the public site root, which
 * serves the Next.js marketing app rather than the `/api/v1` surface, and it
 * treated an unparseable body as a pass (`list_markets OK -> ? markets`). Both
 * are asserted against here: there is no default target, and a markup body is
 * a hard failure.
 */

const MARKETING_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>' +
  '<link rel="preload" as="script" href="/_next/static/chunks/15xrurgzs99gv.js"/>' +
  "</head><body>Nexus</body></html>";

const MARKETS_JSON = JSON.stringify([
  {
    market_id: "BTC-USDX-PERP",
    last_trade_price: 100000,
    volume_24h: 1234,
  },
  { market_id: "ETH-USDX-PERP", last_trade_price: 1900, volume_24h: 99 },
]);

test("resolveTarget: no default — an unset base URL is a hard stop", () => {
  assert.throws(() => resolveTarget({}), SmokeConfigError);
  // The message must name the variable the operator has to set, and say why
  // there is no fallback.
  assert.throws(
    () => resolveTarget({}),
    (err: Error) =>
      err.message.includes(BASE_URL_ENV) && err.message.includes("no default"),
  );
});

test("resolveTarget: blank and whitespace-only values are not a target", () => {
  // Empty string and whitespace are classic sentinels that read as "set".
  for (const raw of ["", " ", "\t\n"]) {
    assert.throws(
      () => resolveTarget({ [BASE_URL_ENV]: raw }),
      SmokeConfigError,
      `expected ${JSON.stringify(raw)} to be rejected`,
    );
  }
});

test("resolveTarget: non-URL and non-http(s) values are rejected", () => {
  for (const raw of [
    "exchange.nexus.xyz",
    "not a url",
    "file:///etc/passwd",
    "ftp://example.com",
  ]) {
    assert.throws(
      () => resolveTarget({ [BASE_URL_ENV]: raw }),
      SmokeConfigError,
      `expected ${JSON.stringify(raw)} to be rejected`,
    );
  }
});

test("resolveTarget: an explicit http(s) target passes through verbatim", () => {
  assert.equal(
    resolveTarget({ [BASE_URL_ENV]: "http://localhost:9090" }),
    "http://localhost:9090",
  );
  assert.equal(
    resolveTarget({ [BASE_URL_ENV]: "  https://indexer.example.com  " }),
    "https://indexer.example.com",
  );
});

test("looksLikeMarkup: recognizes the marketing page and other markup", () => {
  assert.equal(looksLikeMarkup(MARKETING_HTML), true);
  assert.equal(looksLikeMarkup("\n  <!doctype html>"), true);
  assert.equal(looksLikeMarkup("<html><body>nope</body></html>"), true);
  assert.equal(looksLikeMarkup('<?xml version="1.0"?><Error/>'), true);
  assert.equal(looksLikeMarkup("<h1>502 Bad Gateway</h1>"), true);
  assert.equal(looksLikeMarkup(MARKETS_JSON), false);
  assert.equal(looksLikeMarkup("[]"), false);
});

test("containsMarkup: finds markup wrapped in the client's error message", () => {
  // This is the shape the failing default produced: the marketing page arrives
  // embedded in `Exchange API 404: …`, so it is not at offset zero.
  const wrapped = `Error calling list_markets: Exchange API 404: ${MARKETING_HTML}`;
  assert.equal(looksLikeMarkup(wrapped), false, "not markup at offset zero");
  assert.equal(containsMarkup(wrapped), true, "but markup is embedded");
  // A genuine JSON API error must not be misreported as a wrong target.
  assert.equal(
    containsMarkup('Exchange API 400: {"error":"bad market_id"}'),
    false,
  );
});

test("assertMarketPayload: rejects an HTML body naming the misconfiguration", () => {
  assert.throws(() => assertMarketPayload(MARKETING_HTML), SmokeResponseError);
  assert.throws(
    () => assertMarketPayload(MARKETING_HTML),
    (err: Error) =>
      err.message.includes("HTML, not JSON") &&
      err.message.includes(BASE_URL_ENV),
  );
});

test("assertMarketPayload: rejects a 2xx HTML body arriving JSON-quoted", () => {
  // The client cannot parse an HTML 200, so it returns the raw text as the
  // tool result and the server JSON-stringifies it — the markup ends up one
  // string layer down. The old script counted this as `OK -> ? markets`.
  const quoted = JSON.stringify(MARKETING_HTML);
  assert.equal(looksLikeMarkup(quoted), false, "markup is not at offset zero");
  assert.throws(
    () => assertMarketPayload(quoted),
    (err: Error) =>
      err instanceof SmokeResponseError &&
      err.message.includes("2xx with HTML"),
  );
});

test("assertMarketPayload: rejects a body that is not JSON at all", () => {
  // The old script caught the parse error and still printed "OK".
  assert.throws(() => assertMarketPayload("not json"), SmokeResponseError);
  assert.throws(() => assertMarketPayload(""), SmokeResponseError);
});

test("assertMarketPayload: rejects JSON that is not an array of summaries", () => {
  for (const body of [
    '{"error":"unauthorized"}',
    '"a string"',
    "null",
    "42",
    '["BTC-USDX-PERP"]',
    '[{"id":"BTC-USDX-PERP"}]',
    '[{"market_id":123}]',
  ]) {
    assert.throws(
      () => assertMarketPayload(body),
      SmokeResponseError,
      `expected ${body} to be rejected`,
    );
  }
});

test("assertMarketPayload: accepts a real market-summary array", () => {
  const markets = assertMarketPayload(MARKETS_JSON);
  assert.equal(markets.length, 2);
});

test("assertMarketPayload: an empty array is a pass, not a silent zero", () => {
  // An indexer with no markets legitimately returns []. It is reported as 0,
  // which is a real count — not the "?" the old script printed for a body it
  // could not read.
  assert.deepEqual(assertMarketPayload("[]"), []);
});
