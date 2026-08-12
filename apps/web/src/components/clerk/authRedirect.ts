export interface ClerkSignInProps {
  forceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

export interface ClerkSignUpProps {
  forceRedirectUrl?: string;
  signInForceRedirectUrl?: string;
}

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

export function resolveClerkSignUpProps(href: string, isElectron: boolean): ClerkSignUpProps {
  if (isElectron) {
    const redirectUrl = resolveClerkDesktopRedirectUrl(href);
    return {
      forceRedirectUrl: redirectUrl,
      signInForceRedirectUrl: redirectUrl,
    };
  }
  return { forceRedirectUrl: href };
}
