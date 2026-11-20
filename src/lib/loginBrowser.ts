import type { AccountInfo } from "../types";

/** How the backend opened the sign-in link (see `open_login_url`). */
export interface LoginBrowserOpened {
  mode: "profile" | "private";
  profile_name?: string | null;
}

/**
 * The email whose Chrome profile should open the sign-in link: the saved email on
 * a re-login, else the typed name when it is an email address.
 */
export function loginEmailFor(
  reloginAccount: Pick<AccountInfo, "email" | "name"> | null | undefined,
  name: string
): string | null {
  const candidates = [reloginAccount?.email, reloginAccount?.name, name];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return value;
  }
  return null;
}

/** One plain line saying where the sign-in page opened. */
export function openedNote(opened: LoginBrowserOpened | null, email: string | null): string {
  if (!opened) {
    return email
      ? `Opened in your default browser. If it signs in the wrong account, copy the link into the Chrome profile for ${email}.`
      : "Opened in your default browser.";
  }
  if (opened.mode === "profile") {
    const profile = opened.profile_name ? `"${opened.profile_name}" ` : "";
    return `Opened in the Chrome profile ${profile}for ${email ?? "this account"}.`;
  }
  return email
    ? `No Chrome profile is signed in to ${email}, so it opened in a private window. Sign in there with ${email}.`
    : "Opened in a private Chrome window, so your other ChatGPT login can't get in the way.";
}
