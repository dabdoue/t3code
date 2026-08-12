export interface ClerkSignInProps {
  forceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

export const T3_CONNECT_ACCOUNT_PORTAL_SIGN_UP_URL = "https://accounts.t3.codes/sign-up";

export type ClerkSignUpAction =
  | { type: "clerk"; props: { forceRedirectUrl: string } }
  | { type: "hosted"; url: string };

function resolveClerkDesktopRedirectUrl(href: string): string {
  // Electron routes through the hash, so reset any Clerk virtual pathname without losing the T3 page.
  const redirectUrl = new URL(href);
  redirectUrl.pathname = "/";
  redirectUrl.search = "";
  return redirectUrl.toString();
}

export function resolveClerkSignInProps(href: string, isElectron: boolean): ClerkSignInProps {
  if (isElectron) {
    const redirectUrl = resolveClerkDesktopRedirectUrl(href);

    return {
      forceRedirectUrl: redirectUrl,
      signUpForceRedirectUrl: redirectUrl,
    };
  }
  return { forceRedirectUrl: href };
}

export function resolveClerkSignUpAction(href: string, isElectron: boolean): ClerkSignUpAction {
  if (isElectron) {
    return { type: "hosted", url: T3_CONNECT_ACCOUNT_PORTAL_SIGN_UP_URL };
  }
  return { type: "clerk", props: { forceRedirectUrl: href } };
}
