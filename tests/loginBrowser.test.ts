import assert from "node:assert/strict";
import test from "node:test";

import { loginEmailFor, openedNote } from "../src/lib/loginBrowser.ts";

test("re-login uses the saved email, else the typed name when it is an email", () => {
  assert.equal(loginEmailFor({ email: "saved@example.test", name: "Work" }, ""), "saved@example.test");
  assert.equal(loginEmailFor({ email: null, name: "named@example.test" }, ""), "named@example.test");
  assert.equal(loginEmailFor(null, "  typed@example.test "), "typed@example.test");
  assert.equal(loginEmailFor(null, "Work account"), null);
  assert.equal(loginEmailFor(undefined, ""), null);
});

test("the note says where the sign-in page opened", () => {
  assert.equal(
    openedNote({ mode: "profile", profile_name: "Gustavo" }, "a@example.test"),
    'Opened in the Chrome profile "Gustavo" for a@example.test.'
  );
  assert.match(openedNote({ mode: "private" }, "a@example.test"), /private window\. Sign in there with a@example\.test/);
  assert.match(openedNote({ mode: "private" }, null), /private Chrome window/);
  assert.match(openedNote(null, "a@example.test"), /default browser.*a@example\.test/);
});
