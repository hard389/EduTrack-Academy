import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const source = readFileSync(
  new URL("../server/apiRouteDispatcher.ts", import.meta.url),
  "utf8"
);

const javascript = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS
  }
}).outputText;

const loaded = { exports: {} };

vm.runInNewContext(javascript, {
  module: loaded,
  exports: loaded.exports
});

const { defineApiRoute, dispatchApiRoutes } = loaded.exports;

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,

    setHeader(name, value) {
      this.headers[name] = value;
    },

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(data) {
      this.payload = data;
      return this;
    }
  };
}

test("dynamic UID and all original request data are preserved", async () => {
  let received;

  const req = {
    method: "POST",
    headers: { authorization: "Bearer local-test-token" },
    body: { active: false },
    query: {
      path: ["customers", "customer_123", "status"],
      page: "2"
    }
  };

  const res = responseMock();

  await dispatchApiRoutes(req, res, [
    defineApiRoute(
      ["customers", ":uid", "status"],
      (routedReq, routedRes) => {
        received = routedReq;
        return routedRes.status(200).json({
          uid: routedReq.query.uid
        });
      }
    )
  ]);

  assert.equal(res.statusCode, 200);
  assert.equal(received.query.uid, "customer_123");
  assert.equal(received.query.page, "2");
  assert.deepEqual(received.body, req.body);
  assert.equal(received.method, "POST");
  assert.equal(received.headers.authorization, req.headers.authorization);
  assert.equal(req.query.uid, undefined);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("static route preserves existing query parameters", async () => {
  let received;

  const res = responseMock();

  await dispatchApiRoutes({
    method: "GET",
    query: {
      path: ["invoices"],
      period: "2026-11",
      page: "3"
    }
  }, res, [
    defineApiRoute(["invoices"], (req, response) => {
      received = req;
      return response.status(200).json({ success: true });
    })
  ]);

  assert.equal(res.statusCode, 200);
  assert.equal(received.query.period, "2026-11");
  assert.equal(received.query.page, "3");
});

test("original handler retains responsibility for HTTP method validation", async () => {
  const res = responseMock();

  await dispatchApiRoutes({
    method: "PUT",
    query: { path: ["dashboard"] }
  }, res, [
    defineApiRoute(["dashboard"], (req, response) => {
      if (req.method !== "GET") {
        response.setHeader("Allow", "GET");
        return response.status(405).json({
          success: false,
          error: "Method not allowed"
        });
      }
    })
  ]);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
});

test("unmatched paths return 404 without invoking another handler", async () => {
  let invoked = 0;
  const res = responseMock();

  await dispatchApiRoutes({
    method: "POST",
    query: {
      path: ["customers", "uid", "status", "unexpected"]
    }
  }, res, [
    defineApiRoute(["customers", ":uid", "status"], () => {
      invoked++;
    })
  ]);

  assert.equal(invoked, 0);
  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.success, false);
});

test("unknown namespace cannot invoke a registered handler", async () => {
  let invoked = 0;
  const res = responseMock();

  await dispatchApiRoutes({
    method: "GET",
    query: { path: ["unknown", "endpoint"] }
  }, res, [
    defineApiRoute(["dashboard"], () => {
      invoked++;
    })
  ]);

  assert.equal(invoked, 0);
  assert.equal(res.statusCode, 404);
});


test("rewrite path query resolves a nested route and preserves caller query", async () => {
  let received;
  const res = responseMock();

  await dispatchApiRoutes({
    method: "POST",
    body: { test: true },
    query: {
      __route_path: "attendance/queue",
      path: "caller-filter",
      period: "2026-11"
    }
  }, res, [
    defineApiRoute(["attendance", "queue"], (req, response) => {
      received = req;
      return response.status(200).json({ success: true });
    })
  ]);

  assert.equal(res.statusCode, 200);
  assert.equal(received.query.path, "caller-filter");
  assert.equal(received.query.period, "2026-11");
  assert.deepEqual(received.body, { test: true });
});
