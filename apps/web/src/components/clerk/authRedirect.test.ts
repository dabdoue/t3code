import { describe, expect, it } from "vite-plus/test";

import {
  resolveClerkSignInProps,
  resolveClerkSignUpAction,
  T3_CONNECT_ACCOUNT_PORTAL_SIGN_UP_URL,
} from "./authRedirect";

describe("resolveClerkSignInProps", () => {
  it("returns to the current browser URL on the web", () => {
    const href = "https://app.t3.codes/connect?state=state-1#details";
    expect(resolveClerkSignInProps(href, false)).toEqual({ forceRedirectUrl: href });
  });

  it("removes a Clerk virtual pathname and callback params while preserving the desktop route", () => {
    expect(
      resolveClerkSignInProps(
        "t3code://app/CLERK-ROUTER/VIRTUAL/sign-up?__clerk_status=complete#/settings/connections",
        true,
      ),
    ).toEqual({
      forceRedirectUrl: "t3code://app/#/settings/connections",
      signUpForceRedirectUrl: "t3code://app/#/settings/connections",
    });
  });

  it("preserves a clean development desktop route", () => {
    expect(resolveClerkSignInProps("t3code-dev://app/#/settings/general", true)).toEqual({
      forceRedirectUrl: "t3code-dev://app/#/settings/general",
      signUpForceRedirectUrl: "t3code-dev://app/#/settings/general",
    });
  });
});

describe("resolveClerkSignUpAction", () => {
  it("uses Clerk's embedded sign-up flow on the web", () => {
    const href = "https://app.t3.codes/connect?state=state-1#details";
    expect(resolveClerkSignUpAction(href, false)).toEqual({
      type: "clerk",
      props: { forceRedirectUrl: href },
    });
  });

  it("uses Clerk's hosted account portal on desktop", () => {
    expect(resolveClerkSignUpAction("t3code://app/#/settings/connections", true)).toEqual({
      type: "hosted",
      url: T3_CONNECT_ACCOUNT_PORTAL_SIGN_UP_URL,
    });
  });
});
