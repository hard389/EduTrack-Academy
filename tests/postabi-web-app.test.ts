import test from "node:test";
import assert from "node:assert/strict";
import {
  POSTABI_WEB_APP_SEND_URL,
  sendPostabiWebAppMessage,
} from "../server/postabiWebApp.ts";

const credentials = { appKey: "test-app-key", authKey: "test-auth-key" };

function replaceFetch(handler: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test("Web App sender uses the published App Key/Auth Key endpoint and multipart contract", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const restore = replaceFetch(async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({
      status: "Success",
      data: { from: "923334445566", to: "923001234567", status_code: 200, message_id: "msg-test-123" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    const result = await sendPostabiWebAppMessage({
      credentials,
      to: "+92 300 1234567",
      type: "image",
      url: "https://example.test/notification.png",
    });

    assert.equal(POSTABI_WEB_APP_SEND_URL, "https://webapi.postabi.com/api/whatsapp-web/send-message");
    assert.equal(requestUrl, POSTABI_WEB_APP_SEND_URL);
    assert.equal(requestInit?.method, "POST");
    assert.ok(requestInit?.body instanceof FormData);
    const body = requestInit?.body as FormData;
    assert.equal(body.get("app_key"), credentials.appKey);
    assert.equal(body.get("auth_key"), credentials.authKey);
    assert.equal(body.get("to"), "923001234567");
    assert.equal(body.get("type"), "image");
    assert.equal(body.get("url"), "https://example.test/notification.png");
    assert.equal(result.accepted, true);
    assert.equal(result.messageId, "msg-test-123");
  } finally {
    restore();
  }
});

test("a successful HTTP response with an unrecognized provider body is not treated as accepted", async () => {
  const restore = replaceFetch(async () => new Response("<html>not json</html>", { status: 200 }));
  try {
    const result = await sendPostabiWebAppMessage({
      credentials,
      to: "923001234567",
      type: "text",
      message: "Safe test body",
    });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.accepted, false);
    assert.equal(result.messageId, null);
  } finally {
    restore();
  }
});

test("non-2xx provider rejection is preserved without inventing acceptance", async () => {
  const restore = replaceFetch(async () => new Response(JSON.stringify({ status: "Unauthorized" }), { status: 401 }));
  try {
    const result = await sendPostabiWebAppMessage({
      credentials,
      to: "923001234567",
      type: "text",
      message: "Safe test body",
    });
    assert.equal(result.httpStatus, 401);
    assert.equal(result.accepted, false);
  } finally {
    restore();
  }
});

test("invalid recipient is blocked before any provider request", async () => {
  let called = false;
  const restore = replaceFetch(async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  try {
    await assert.rejects(
      sendPostabiWebAppMessage({ credentials, to: "invalid", type: "text", message: "Safe test body" }),
      /valid recipient number/i,
    );
    assert.equal(called, false);
  } finally {
    restore();
  }
});
