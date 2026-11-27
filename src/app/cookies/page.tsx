import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/LegalPage";
import { SIDEBAR_KEY, THEME_KEY } from "@/components/themeScript";
import { COOKIE_NOTICE_KEY } from "@/lib/legal";
import { SESSION_COOKIE } from "@/lib/sessionCookie";

export const metadata: Metadata = { title: "Cookie notice · Velza Traceability" };

// Keep this list in step with the code: grep for "set-cookie" and "localStorage" before changing it.
const ITEMS: { name: string; type: string; purpose: string; lasts: string }[] = [
  { name: SESSION_COOKIE, type: "Cookie (HttpOnly, first party)", purpose: "Keeps you signed in. Without it the portal cannot work.", lasts: "12 hours, or until you sign out" },
  { name: THEME_KEY, type: "Browser storage", purpose: "Remembers light, dark or system theme", lasts: "Until you clear it" },
  { name: SIDEBAR_KEY, type: "Browser storage", purpose: "Remembers whether the menu is collapsed", lasts: "Until you clear it" },
  { name: "velza.thisPc", type: "Browser storage (plant PCs only)", purpose: "Remembers which registered plant PC this browser is", lasts: "Until you clear it" },
  { name: COOKIE_NOTICE_KEY, type: "Browser storage", purpose: "Remembers that you have seen the cookie notice", lasts: "Until you clear it" },
];

export default function CookiesPage() {
  return (
    <LegalPage
      title="Cookie notice"
      intro={
        <p>
          Velza Traceability uses <strong>one cookie</strong>, and only to keep you signed in. It sets no advertising, analytics or third-party cookies,
          so there is nothing to opt in to or out of.
        </p>
      }
    >
      <LegalSection id="list" title="What we store in your browser">
        <div className="overflow-x-auto rounded-control border border-line">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <caption className="sr-only">Cookies and browser storage</caption>
            <thead className="bg-surface-2">
              <tr>
                <th scope="col" className="p-3 font-semibold">Name</th>
                <th scope="col" className="p-3 font-semibold">Type</th>
                <th scope="col" className="p-3 font-semibold">Purpose</th>
                <th scope="col" className="p-3 font-semibold">How long</th>
              </tr>
            </thead>
            <tbody>
              {ITEMS.map((i) => (
                <tr key={i.name} className="border-t border-line align-top">
                  <th scope="row" className="p-3 font-mono text-xs font-semibold">{i.name}</th>
                  <td className="p-3">{i.type}</td>
                  <td className="p-3">{i.purpose}</td>
                  <td className="p-3">{i.lasts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </LegalSection>
      <LegalSection id="control" title="Your choices">
        <p>
          You can delete cookies and browser storage in your browser settings at any time. If you block the session cookie you will not be able to sign in.
          The public product-check page works without any cookie.
        </p>
        <p>
          If we ever add a cookie that is not strictly needed, such as analytics, we will ask for your consent first and update this notice. See also the{" "}
          <a href="/privacy">privacy notice</a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
